const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

let context;
let panel;
let target;
let errors;
let network;

test.beforeEach(async () => {
  const extensionPath = path.resolve(__dirname, '../apps/extension/dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.permissions).toEqual(['sidePanel', 'activeTab', 'scripting', 'storage']);
  expect(manifest.host_permissions).toEqual(['http://127.0.0.1:8765/*']);
  expect(manifest.content_scripts).toBeUndefined();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.PIKO_CHROMIUM_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  errors = [];
  network = [];
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  await context.route(/^https?:/, (route) => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await expect.poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
    .toEqual({ openPanelOnActionClick: false });

  // A separate target-page fixture must stay untouched throughout the UI flow.
  target = await context.newPage();
  await target.setContent('<form><input aria-label="Unrelated field" value="Unchanged"><button>Submit</button></form>');
  await target.evaluate(() => {
    window.__submitted = false;
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      window.__submitted = true;
    });
  });
  panel = await context.newPage();
  panel.on('pageerror', (error) => errors.push(error.message));
  panel.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await panel.addInitScript(() => {
    window.__forbiddenCalls = [];
    function block(name) {
      return function () { window.__forbiddenCalls.push(name); throw new Error(`Forbidden capability: ${name}`); };
    }
    window.fetch = block('fetch');
    window.WebSocket = block('WebSocket');
    XMLHttpRequest.prototype.open = block('XMLHttpRequest');
    Storage.prototype.setItem = block('persistent storage');
    indexedDB.open = block('IndexedDB');
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = block('microphone');
    if (window.speechSynthesis) speechSynthesis.speak = block('speech playback');
  });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/${manifest.side_panel.default_path}`);
});

test.afterEach(async () => {
  try {
    if (panel && !panel.isClosed()) expect(await panel.evaluate(() => window.__forbiddenCalls)).toEqual([]);
    if (target && !target.isClosed()) {
      await expect(target.getByRole('textbox', { name: 'Unrelated field' })).toHaveValue('Unchanged');
      expect(await target.evaluate(() => window.__submitted)).toBe(false);
    }
    expect(errors).toEqual([]);
    expect(network).toEqual([]);
  } finally {
    await context?.close();
  }
});

async function loadConversation() {
  await panel.getByRole('button', { name: 'Load demo form', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'A form to practice with.' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Synthetic fields' }).getByRole('listitem')).toHaveCount(5);
  await panel.getByRole('button', { name: 'Start conversation', exact: true }).click();
}

async function loadReview() {
  await loadConversation();
  await expect(panel.getByRole('button', { name: 'Microphone unavailable' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Review proposed values' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Use sample answer' }).click();
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).toContainText('Still missing: Organization');
  await panel.getByRole('button', { name: 'Review proposed values' }).click();
}

test('idle, loading, reset and error states remain accessible without connections', async ({}, testInfo) => {
  await expect(panel.getByRole('heading', { name: 'Local Voice Form Assistant', exact: true })).toBeVisible();
  await expect(panel.getByText('Local runtime not connected', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Inspect this page', exact: true })).toBeEnabled();
  await panel.screenshot({ path: testInfo.outputPath('idle.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Load demo form', exact: true }).focus();
  await panel.keyboard.press('Enter');
  await expect(panel.getByLabel('Preparing synthetic form')).toBeVisible();
  await panel.getByRole('button', { name: 'Reset session' }).click();
  await expect(panel.getByRole('heading', { name: 'Local Voice Form Assistant', exact: true })).toBeFocused();
  await expect(panel.getByText('No demo loaded.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start conversation' })).toHaveCount(0);
  await panel.getByText('Demo scenarios', { exact: true }).click();
  await panel.getByRole('button', { name: 'Show demo error' }).click();
  await expect(panel.getByRole('alert')).toContainText('simulated preparation error');
  await panel.getByRole('button', { name: 'Reset session' }).click();
  await expect(panel.getByRole('heading', { name: 'Local Voice Form Assistant', exact: true })).toBeVisible();
});

test('conversation, typed fallback, editing and deselection lead to an accurate simulated summary', async ({}, testInfo) => {
  await loadConversation();
  await panel.getByRole('button', { name: 'Use sample answer' }).click();
  await panel.getByRole('textbox', { name: 'Your answer' }).fill('Example Research');
  await panel.getByRole('button', { name: 'Add typed answer' }).click();
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).toContainText('Organization: Example Research');
  await panel.getByRole('button', { name: 'Review proposed values' }).click();
  const name = panel.getByRole('article', { name: 'Full name', exact: true });
  await name.getByRole('textbox', { name: 'Full name', exact: true }).fill('Edited Example');
  await panel.getByRole('textbox', { name: 'Email address', exact: true }).fill('edited@example.test');
  await panel.getByRole('textbox', { name: 'Phone number', exact: true }).fill('+1 202-555-0199');
  await panel.getByRole('combobox', { name: 'Contact preference', exact: true }).selectOption('sms');
  await panel.getByRole('textbox', { name: 'Organization', exact: true }).fill('Example Laboratory');
  await panel.getByRole('checkbox', { name: 'Include phone number' }).uncheck();
  await expect(name).toContainText('Source: User-provided');
  const preview = panel.getByRole('region', { name: 'Approval preview', exact: true });
  await expect(preview).toContainText('Edited Example');
  await expect(preview).toContainText('edited@example.test');
  await expect(preview).toContainText('SMS');
  await expect(preview).toContainText('Example Laboratory');
  await expect(preview).not.toContainText('Phone number');
  for (const width of [280, 360, 480]) {
    await panel.setViewportSize({ width, height: 800 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 360) await panel.screenshot({ path: testInfo.outputPath('review.png'), fullPage: true });
  }
  await panel.getByRole('button', { name: 'Simulate approval', exact: true }).click();
  const result = panel.getByRole('region', { name: 'Simulated approval summary' });
  await expect(result).toContainText('Edited Example');
  await expect(result).not.toContainText('Phone number');
  await expect(result).toContainText('No webpage has been modified');
  await expect(result.getByRole('textbox')).toHaveCount(0);
  await expect(panel.getByLabel('Assistant message to speak')).toBeVisible();
  await expect(panel.getByText('Approval simulated · 0 values inserted', { exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('approval.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Reset session' }).click();
  await expect(panel.getByText('Edited Example', { exact: true })).toHaveCount(0);
  await loadConversation();
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).not.toContainText('Example Laboratory');
});

test('missing values, invalid input, empty selection and returning to conversation are handled safely', async () => {
  await loadReview();
  const organization = panel.getByRole('textbox', { name: 'Organization', exact: true });
  await expect(organization).toHaveValue('');
  await expect(panel.getByRole('checkbox', { name: 'Include organization' })).toBeDisabled();
  await expect(panel.getByText('Required information is missing', { exact: true })).toBeVisible();
  const preview = panel.getByRole('region', { name: 'Approval preview', exact: true });
  await expect(preview).not.toContainText('Organization');
  await panel.getByRole('textbox', { name: 'Email address', exact: true }).fill('invalid-email');
  await panel.getByRole('button', { name: 'Simulate approval', exact: true }).click();
  await expect(panel.getByText('Enter a valid email address.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Simulated approval summary' })).toHaveCount(0);
  await panel.getByRole('textbox', { name: 'Email address', exact: true }).fill('corrected@example.test');
  for (const label of ['full name', 'email address', 'phone number', 'contact preference']) {
    await panel.getByRole('checkbox', { name: `Include ${label}`, exact: true }).uncheck();
  }
  await expect(preview).toContainText('No values selected');
  await expect(panel.getByRole('button', { name: 'Simulate approval', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(panel.getByRole('heading', { name: 'Let’s prepare your answers.' })).toBeVisible();
  await panel.getByRole('button', { name: 'Review proposed values' }).click();
  await panel.getByRole('textbox', { name: 'Full name', exact: true }).fill('');
  await expect(panel.getByRole('checkbox', { name: 'Include full name', exact: true })).toBeDisabled();
  await expect(preview).not.toContainText('Full name');
  await panel.getByRole('checkbox', { name: 'Include email address', exact: true }).check();
  await panel.getByRole('button', { name: 'Simulate approval', exact: true }).click();
  const result = panel.getByRole('region', { name: 'Simulated approval summary' });
  await expect(result).toContainText('corrected@example.test');
  await expect(result).not.toContainText('Organization');
  await expect(result).not.toContainText('Full name');
  await panel.reload();
  await expect(panel.getByRole('heading', { name: 'Local Voice Form Assistant', exact: true })).toBeVisible();
});
