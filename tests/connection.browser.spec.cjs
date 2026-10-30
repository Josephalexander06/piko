const { test, expect, chromium } = require('@playwright/test');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const extension = path.resolve(__dirname, '../apps/extension/dist');
const serviceDirectory = path.resolve(__dirname, '../apps/local-service');
const python = process.env.PIKO_PYTHON_PATH || path.join(serviceDirectory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sessionKey = 'piko.localService.session.v1';
const serviceURL = 'http://127.0.0.1:8765';
let context, panel, worker, service, fake, requests, errors, failures;

async function stopService() {
  if (!service) return;
  const running = service; service = undefined;
  if (running.exitCode === null) { const exited = once(running, 'exit'); running.kill(); await exited; }
  // Windows can report process exit slightly before releasing its listener.
  await expect.poll(async () => {
    const probe = net.createServer();
    return new Promise(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen(8765, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
  }, { timeout: 5000, intervals: [50, 100, 250, 500] }).toBe(true);
}
async function startService() {
  // Never terminate or replace a user's existing service.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(8765, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(python, ['-m', 'app'], { cwd: serviceDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  service = child;
  const code = await new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(Error('Companion startup timed out')), 10000);
    child.once('error', () => { clearTimeout(timeout); reject(Error('Could not launch the companion test process')); });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('Companion test process exited before startup')); });
    child.stderr.on('data', () => {}); // Consume diagnostics without recording secrets.
    child.stdout.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-2048);
      const match = /Piko companion service running|Piko pairing code/.exec(buffer);
      if (match) { clearTimeout(timeout); buffer = ''; resolve('ready'); }
    });
  });
  await expect.poll(async () => { try { return (await fetch(`${serviceURL}/v1/health`)).status; } catch { return 0; } }).toBe(200);
  return code;
}
async function openPanel() {
  panel = await context.newPage();
  panel.on('pageerror', error => errors.push(error.message));
  panel.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await panel.addInitScript(() => {
    window.__forbidden = [];
    for (const [object, name] of [[window, 'fetch'], [XMLHttpRequest.prototype, 'open'], [Storage.prototype, 'setItem'], [indexedDB, 'open']]) {
      object[name] = () => { window.__forbidden.push(name); throw Error('Panel must use worker messages and no persistent storage'); };
    }
  });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
  await panel.getByText('Local service connection', { exact: true }).click();
  await expect(panel.getByRole('button', { name: /Check service/i })).toBeEnabled();
}
async function pair(_code) {
  await panel.getByRole('button', { name: /Connect to companion|Pair extension/ }).click();
  try { await expect(panel.getByText(/Companion (paired|connected)/)).toBeVisible(); }
  catch { throw Error(JSON.stringify({ network: requests.map(({ url, method, origin, authenticated }) => ({ url, method, origin, authenticated })), failures })); }
}
const savedSession = () => worker.evaluate(async key => (await chrome.storage.session.get(key))[key], sessionKey);
test.beforeEach(async () => {
  requests = []; errors = []; failures = []; service = undefined; fake = undefined;
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, executablePath: process.env.PIKO_CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-extension-debugging'], ignoreDefaultArgs: ['--disable-extensions'],
  });
  // CDP installation is test setup only, and supports branded Chrome versions
  // that no longer accept --load-extension on their command line.
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: extension });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  context.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push({ url: request.url(), method: request.method(), origin: request.headers().origin ?? 'absent', authenticated: Boolean(request.headers().authorization), navigation: request.isNavigationRequest(), worker: Boolean(request.serviceWorker()), body: request.postData() });
  });
  context.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
  await openPanel();
});
test.afterEach(async () => {
  try {
    if (panel && !panel.isClosed()) expect(await panel.evaluate(() => window.__forbidden)).toEqual([]);
    expect(errors).toEqual([]);
    expect(requests.every(request => request.url.startsWith(`${serviceURL}/v1/`))).toBe(true);
    expect(requests.every(request => request.worker || request.method === 'OPTIONS' || request.navigation && request.url === `${serviceURL}/v1/health`)).toBe(true);
    for (const request of requests.filter(request => request.body)) expect(Object.keys(JSON.parse(request.body)).sort()).toEqual(['code', 'protocol_version']);
  } finally {
    await context?.close();
    await stopService();
    if (fake) { fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve)); }
  }
});

test('real Chrome worker pairs, retrieves capabilities, pings and revokes without exposing tokens to UI or content scripts', async ({}, testInfo) => {
  const code = await startService();
  await panel.getByRole('button', { name: 'Check service', exact: true }).click();
  await expect.poll(async () => ({ available: await panel.getByText('Companion available · not paired', { exact: true }).isVisible(), failures: [...failures] })).toMatchObject({ available: true });
  await pair(code);
  await expect(panel.getByRole('list', { name: 'Local service capabilities' })).toContainText(/Inference: (ready|unavailable)/);
  await panel.getByRole('button', { name: 'Authenticated ping', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Authenticated ping', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Check capabilities', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Check capabilities', exact: true })).toBeEnabled();
  const saved = await savedSession();
  expect(typeof saved.token === 'string' && saved.token.length === 43).toBe(true);
  expect((await panel.content()).includes(saved.token)).toBe(false);
  expect((await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null))))).toBe('{}');
  expect((await worker.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null))))).toBe('{}');
  const target = await context.newPage(); await target.goto(`${serviceURL}/v1/health`);
  const blocked = await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: async () => {
      try { if (!chrome.storage?.session) return true; await chrome.storage.session.get(null); return false; } catch { return true; }
    } }))[0].result;
  }, `${serviceURL}/v1/health`);
  expect(blocked).toBe(true); await target.close();
  await panel.getByRole('button', { name: 'Disconnect service', exact: true }).click();
  await expect(panel.getByText(/Local runtime not connected|Local companion disconnected/)).toBeVisible();
  expect(await savedSession()).toBeUndefined();
  for (const width of [280, 360, 480]) { await panel.setViewportSize({ width, height: 800 }); expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await panel.screenshot({ path: testInfo.outputPath('companion-connection.png'), fullPage: true });
});

test('direct connect creates session without pairing code', async () => {
  await startService();
  await pair();
  const saved = await savedSession();
  expect(saved.token).toBeTruthy();
});

test('service restart invalidates stored credentials and a fresh code can pair without stale connected state', async () => {
  await pair(await startService());
  const previous = await savedSession(); await stopService(); const newCode = await startService();
  await panel.getByRole('button', { name: /Ping service|Authenticated ping/i }).click();
  await expect(panel.getByText(/Companion (session expired|disconnected)/)).toBeVisible();
  expect(await savedSession()).toBeUndefined();
  await pair(newCode);
  expect((await savedSession()).token === previous.token).toBe(false);
});

test('offline disconnect is marked unconfirmed and retained credential is restricted to revocation', async () => {
  await pair(await startService()); await stopService();
  await panel.getByRole('button', { name: 'Disconnect service', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('server revocation is not confirmed');
  expect((await savedSession()).pendingRevocation).toBe(true);
  await expect(panel.getByRole('button', { name: 'Pair extension', exact: true })).toBeDisabled();
  await startService();
  await panel.getByRole('button', { name: 'Retry pending disconnect', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Check service', exact: true })).toBeVisible();
  expect(await savedSession()).toBeUndefined();
});

test('actual worker reports unavailable, invalid response, unsupported protocol and timeout distinctly', async () => {
  await panel.getByRole('button', { name: 'Check service', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('companion service is unavailable');
  let mode = 'invalid';
  fake = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'timeout') return;
    response.end(mode === 'invalid' ? '{invalid' : JSON.stringify({ protocol_version: 2 }));
  });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(8765, '127.0.0.1', resolve); });
  await panel.getByRole('button', { name: 'Check service', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('invalid response');
  mode = 'protocol'; await panel.getByRole('button', { name: 'Check service', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('unsupported protocol version');
  mode = 'timeout'; await panel.getByRole('button', { name: 'Check service', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('timed out');
});
