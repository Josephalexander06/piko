const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let server;
let baseURL;
let context;
let worker;
let page;
let panel;
let tabId;
let temporaryExtension;
let extensionId;
let externalRequests;
let panelErrors;
const production = path.resolve(__dirname, '../apps/extension/dist');

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://localhost').pathname;
    if (!['/form-fixture.html', '/empty-fixture.html'].includes(filename)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(__dirname, 'fixtures', filename.slice(1))));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function launch(fixtureAccess) {
  let extensionPath = production;
  if (fixtureAccess) {
    // Headless Chrome cannot click its native toolbar to grant activeTab.
    // Grant only loopback access in an isolated TEST COPY, never the real build.
    temporaryExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'piko-scanner-test-'));
    fs.cpSync(production, temporaryExtension, { recursive: true });
    const manifestPath = path.join(temporaryExtension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    extensionPath = temporaryExtension;
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, executablePath: process.env.PIKO_CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  externalRequests = []; panelErrors = [];
  context.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(baseURL)) externalRequests.push(request.url()); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  page = await context.newPage();
  await page.goto(`${baseURL}/form-fixture.html`);
  panel = await context.newPage();
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  panel.on('console', (message) => { if (message.type() === 'error') panelErrors.push(message.text()); });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await page.bringToFront();
  tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${baseURL}/form-fixture.html`);
}

test.afterEach(async () => {
  try { expect(externalRequests).toEqual([]); expect(panelErrors).toEqual([]); }
  finally {
    await context?.close(); context = undefined;
    if (temporaryExtension) { fs.rmSync(temporaryExtension, { recursive: true, force: true }); temporaryExtension = undefined; }
  }
});

async function requestScan() {
  await page.bringToFront();
  return panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PIKO_SCAN_ACTIVE', requestId: `request_${crypto.randomUUID().replace(/-/g, '')}` }));
}
async function installPrivacyTripwires() {
  await worker.evaluate(async (id) => chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', func: () => {
      globalThis.__pikoForbidden = [];
      for (const [prototype, keys] of [[HTMLInputElement.prototype, ['value', 'checked']], [HTMLTextAreaElement.prototype, ['value']], [HTMLSelectElement.prototype, ['value', 'selectedIndex']], [HTMLOptionElement.prototype, ['value', 'selected']]]) {
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          Object.defineProperty(prototype, key, {
            configurable: true,
            get() { globalThis.__pikoForbidden.push(`read:${key}`); throw new Error('Existing answer read'); },
            set() { globalThis.__pikoForbidden.push(`write:${key}`); throw new Error('Answer write'); },
            enumerable: descriptor.enumerable,
          });
        }
      }
      globalThis.fetch = () => { globalThis.__pikoForbidden.push('fetch'); throw new Error('Network request'); };
      Storage.prototype.setItem = () => { globalThis.__pikoForbidden.push('storage'); throw new Error('Persistence'); };
      HTMLFormElement.prototype.submit = () => { globalThis.__pikoForbidden.push('submit'); throw new Error('Form submission'); };
      HTMLFormElement.prototype.requestSubmit = () => { globalThis.__pikoForbidden.push('requestSubmit'); throw new Error('Form submission'); };
    },
  }), tabId);
}
async function forbiddenCalls() {
  return worker.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', func: () => globalThis.__pikoForbidden }))[0].result, tabId);
}
function fields(response) { return response.result.inventory.forms.flatMap((form) => form.fields); }

test('production build requires an activeTab grant and rejects restricted pages without claiming success', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(production, 'manifest.json'), 'utf8'));
  expect(manifest.permissions).toEqual(['sidePanel', 'activeTab', 'scripting', 'storage']);
  expect(manifest.host_permissions).toEqual(['http://127.0.0.1:8765/*']); expect(manifest.content_scripts).toBeUndefined();
  await launch(false);
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).click();
  await expect(panel.getByText('Page could not be inspected', { exact: true })).toBeVisible();
  await expect(panel.getByText(/toolbar icon/).last()).toBeVisible();
  await page.goto('chrome://version'); await page.bringToFront();
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('cannot be inspected');
});

test('real packaged injection returns correct metadata without reading values, writing or submitting', async ({}, testInfo) => {
  await launch(true);
  await installPrivacyTripwires();
  const before = await page.locator('body').innerHTML();
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Read-only form scanner' })).toContainText('supported fields');
  const result = await requestScan();
  expect(result.ok).toBe(true);
  const all = fields(result);
  expect(new Set(all.map((field) => field.fieldType))).toEqual(new Set(['text', 'email', 'tel', 'number', 'date', 'textarea', 'select', 'radio', 'checkbox']));
  const byLabel = (label) => all.find((field) => field.label === label);
  expect(byLabel('Full name').constraints).toEqual({ minLength: 2, maxLength: 100, patternPresent: true });
  expect(byLabel('Email address').labelSource).toBe('aria-labelledby');
  expect(byLabel('Telephone').labelSource).toBe('aria-label');
  expect(byLabel('Biography').fieldType).toBe('textarea');
  expect(byLabel('Quantity').constraints).toMatchObject({ min: '1', max: '12', step: '0.5' });
  expect(byLabel('Department').options.map((option) => option.label)).toEqual(['Choose a department', 'Engineering', 'Design', 'Archive']);
  expect(byLabel('Department').options.at(-1).disabled).toBe(true);
  const radios = all.filter((field) => field.fieldType === 'radio');
  expect(radios).toHaveLength(2);
  expect(radios[0].label).toBe('Preferred channel'); expect(radios[0].options).toHaveLength(3);
  expect(radios[1].options.map((option) => option.label)).toEqual(['Email', 'Email']);
  expect(byLabel('I agree to the terms and privacy policy').exclusionReasons).toContain('consent');
  expect(byLabel('Disabled answer').eligible).toBe(false);
  expect(byLabel('Disabled by fieldset').enabled).toBe(false);
  expect(byLabel('Read-only answer').eligible).toBe(false);
  expect(byLabel('reference Code').labelUncertain).toBe(true);
  expect(byLabel('Preferred nickname').labelSource).toBe('placeholder');
  expect(all.filter((field) => field.eligible).every((field) => field.visible && field.enabled && !field.readOnly && !field.labelUncertain)).toBe(true);
  expect(result.result.inventory.exclusions).toMatchObject({ hidden: 4, sensitive: 4, disabled: 2, readOnly: 1, consent: 1, uncertainLabel: 2 });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/PRIVATE_|RAW_OPTION_|RAW_RADIO_|RAW_SECOND_|Unrelated page text|Ambiguous nearby text/);
  const identifiers = [result.result.inventory.scanId, result.result.inventory.documentId, ...result.result.inventory.forms.flatMap((form) => [form.formId, ...form.fields.flatMap((field) => [field.fieldId, ...field.options.map((option) => option.optionId)])])];
  expect(new Set(identifiers).size).toBe(identifiers.length);
  expect(identifiers.every((id) => /^[a-z]+_[a-f0-9]{32}$/.test(id))).toBe(true);
  expect(await forbiddenCalls()).toEqual([]);
  expect(await page.locator('body').innerHTML()).toBe(before);
  expect(await page.evaluate(() => window.fixtureEvents)).toEqual({ input: 0, change: 0, submit: 0 });
  const again = await requestScan();
  expect(fields(again).map((field) => field.fieldId)).toEqual(all.map((field) => field.fieldId));
  expect(again.result.inventory.scanId).not.toBe(result.result.inventory.scanId);
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Read-only form scanner' })).toContainText('Registration form');
  for (const width of [280, 360, 480]) {
    await panel.setViewportSize({ width, height: 800 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.screenshot({ path: testInfo.outputPath('scanner-inventory.png'), fullPage: true });
});

test('relevant mutations invalidate scans and replacement fields receive new identifiers', async () => {
  await launch(true);
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Read-only form scanner' })).toContainText('supported fields');
  const before = await requestScan();
  // Synchronize the visible panel with its own fresh scan before mutation.
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect(panel.getByText('Reading field metadata…')).toHaveCount(0);
  await page.locator('#unrelated').evaluate((element) => { element.textContent = 'An unrelated update'; });
  await expect(panel.getByText('Scan is stale', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal conditional field' }).click();
  await expect(panel.getByText('Scan is stale', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect(panel.getByText('Scan is stale', { exact: true })).toHaveCount(0);
  const after = await requestScan();
  expect(fields(after).find((field) => field.label === 'Additional details').required).toBe(true);
  expect(fields(after).some((field) => field.fieldId === fields(before)[0].fieldId)).toBe(false);
  await page.getByRole('button', { name: 'Replace full name' }).click();
  const replacement = await requestScan();
  expect(fields(replacement)[0].fieldId).not.toBe(fields(after)[0].fieldId);
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await page.locator('#email-label').evaluate((node) => { node.textContent = 'Work email'; });
  await expect(panel.getByText('Scan is stale', { exact: true })).toBeVisible();
});

test('empty pages, tab changes and navigation invalidate old metadata without automatically rescanning', async () => {
  await launch(true);
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Read-only form scanner' })).toContainText('supported fields');
  await page.goto(`${baseURL}/empty-fixture.html`);
  await expect(panel.getByText('Scan is stale', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect(panel.getByText(/No supported visible fields were found/)).toBeVisible();
  const other = await context.newPage(); await other.goto(`${baseURL}/empty-fixture.html`);
  await expect(panel.getByText('Scan is stale', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear scan', exact: true }).click();
  await expect(panel.getByText('No page inspected. Scanning begins only when you click.', { exact: true })).toBeVisible();
});

test('option limits and sensitive identifier heuristics fail closed and option mutations stale the inventory', async () => {
  await launch(true);
  await page.evaluate(() => {
    const select = document.getElementById('department');
    for (let index = 0; index < 60; index++) select.add(new Option(`Synthetic option ${index}`, `RAW_LIMIT_${index}`));
    const control = document.createElement('input');
    control.name = 'otpCode'; control.setAttribute('aria-label', 'Security challenge'); control.value = 'PRIVATE_CAMELCASE_OTP';
    document.getElementById('registration').append(control);
  });
  await installPrivacyTripwires();
  const result = await requestScan();
  expect(result.ok).toBe(true);
  const department = fields(result).find((field) => field.label === 'Department');
  expect(department.options).toHaveLength(50);
  expect(department.eligible).toBe(false); expect(department.exclusionReasons).toContain('limit');
  expect(result.result.inventory.truncated).toBe(true);
  expect(result.result.inventory.exclusions.sensitive).toBe(5);
  expect(JSON.stringify(result)).not.toMatch(/RAW_LIMIT_|PRIVATE_CAMELCASE|Security challenge/);
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).click();
  await expect(panel.getByText('The metadata limit was reached. This is a partial inventory.', { exact: true })).toBeVisible();
  await page.locator('#department option').nth(1).evaluate((option) => { option.textContent = 'Changed option label'; });
  await expect(panel.getByText('Scan is stale', { exact: true })).toBeVisible();
  await page.locator('#department').evaluate((select) => { for (const option of select.options) option.disabled = true; });
  const disabledOptions = await requestScan();
  const choice = fields(disabledOptions).find((field) => field.label === 'Department');
  expect(choice.enabled).toBe(true); expect(choice.eligible).toBe(false); expect(choice.exclusionReasons).toContain('no-enabled-options');
  expect(await forbiddenCalls()).toEqual([]);
});


test('the real production action grants activeTab and scans without test host permissions', async () => {
  await launch(false);
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{}] });
  const tabTarget = targetInfos.find((target) => target.type === 'tab' && target.url === page.url());
  expect(tabTarget, JSON.stringify(targetInfos.map(({ type, url }) => ({ type, url })))).toBeTruthy();
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  const result = await requestScan();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(fields(result).find((field) => field.label === 'Full name')).toBeTruthy();
});

test('the panel scans its own window when URL metadata is withheld and another window is focused', async () => {
  await launch(false);
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{}] });
  const tabTarget = targetInfos.find((target) => target.type === 'tab' && target.url === page.url());
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  const otherWindow = await worker.evaluate(async (url) => chrome.windows.create({ url, focused: true }), `${baseURL}/empty-fixture.html`);
  await worker.evaluate(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (options) => (await query(options)).map((tab) => {
      const metadata = { ...tab }; delete metadata.url; delete metadata.pendingUrl; return metadata;
    });
  });
  // Do not refocus the fixture window: the panel must explicitly send its owner.
  await panel.getByRole('button', { name: 'Inspect this page', exact: true }).evaluate((button) => button.click());
  const scanner = panel.getByRole('region', { name: 'Read-only form scanner' });
  await expect(scanner).toContainText('17 supported fields');
  await expect(scanner).toContainText('Registration form');
  await expect(panel.getByText('Page could not be inspected', { exact: true })).toHaveCount(0);
  await expect(panel.getByText(/Piko v0\.1\.1/)).toBeVisible();
  await worker.evaluate(async (id) => chrome.windows.remove(id), otherWindow.id);
});
