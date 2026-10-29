const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const createLoader = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname, '../apps/extension/src');
const load = createLoader();
const { FieldRegistry } = load(path.join(root, 'content/field-registry.ts'));
const messages = load(path.join(root, 'features/scanner/scanner.messages.ts'));
const { isScanInventory } = load(path.join(root, 'features/scanner/scanner.validation.ts'));
const id = (prefix, value) => `${prefix}_${String(value).padStart(32, '0')}`;
function inventory() {
  return { version: 1, scanId: id('scan', 1), documentId: id('doc', 2), origin: 'https://example.test', forms: [
    { formId: id('frm', 3), label: 'Form 1', fields: [{ fieldId: id('fld', 4), label: 'Full name', labelSource: 'label', labelUncertain: false, fieldType: 'text', required: true, visible: true, enabled: true, readOnly: false, eligible: true, exclusionReasons: [], options: [], constraints: { maxLength: 100 } }] },
  ], exclusions: { hidden: 0, sensitive: 0, unsupported: 0, disabled: 0, readOnly: 0, consent: 0, uncertainLabel: 0 }, limitations: ['top-frame-only', 'light-dom-only', 'approximate-visibility'], truncated: false };
}

test('metadata contract accepts bounded fields and rejects existing values and raw option values', () => {
  assert.equal(isScanInventory(inventory()), true);
  for (const property of ['currentValue', 'value', 'checked', 'selected', 'name', 'selector', 'html']) {
    const scan = inventory(); scan.forms[0].fields[0][property] = 'PRIVATE';
    assert.equal(isScanInventory(scan), false, property);
  }
  const scan = inventory();
  scan.forms[0].fields[0].fieldType = 'select';
  scan.forms[0].fields[0].options = [{ optionId: id('opt', 5), label: 'Engineering', disabled: false }];
  assert.equal(isScanInventory(scan), true);
  scan.forms[0].fields[0].options[0].value = 'RAW_SECRET';
  assert.equal(isScanInventory(scan), false);
});

test('validation rejects duplicate IDs, unsupported types, oversized metadata and contradictory eligibility', () => {
  const duplicate = inventory(); duplicate.forms[0].fields.push(structuredClone(duplicate.forms[0].fields[0]));
  assert.equal(isScanInventory(duplicate), false);
  for (const change of [{ enabled: false }, { readOnly: true }, { labelUncertain: true }, { fieldType: 'password' }, { label: 'x'.repeat(257) }]) {
    const scan = inventory(); Object.assign(scan.forms[0].fields[0], change);
    assert.equal(isScanInventory(scan), false);
  }
  const wrongOrigin = inventory(); wrongOrigin.origin = 'https://example.test/private/path';
  assert.equal(isScanInventory(wrongOrigin), false);
});

test('opaque registry IDs are stable only for connected elements in the current scan', () => {
  const owner = {}; const element = { isConnected: true, ownerDocument: owner };
  const registry = new FieldRegistry(owner);
  const first = registry.begin(); const field = registry.field([element]); const option = registry.option(element);
  assert.ok(messages.isOpaqueId(field)); assert.ok(messages.isOpaqueId(option));
  assert.deepEqual(registry.resolve(field, first), [element]);
  const second = registry.begin(); assert.equal(registry.field([element]), field);
  assert.equal(registry.resolve(field, first), undefined);
  element.isConnected = false; assert.equal(registry.resolve(field, second), undefined);
  element.isConnected = true; registry.invalidate(); registry.begin();
  assert.notEqual(registry.field([element]), field);
  assert.notEqual(registry.option(element), option);
});

test('message guards reject extra fields, malformed IDs and unsupported message types', () => {
  const request = { type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 7) };
  assert.equal(messages.isInspectRequest(request), true);
  assert.equal(messages.isInspectRequest({ ...request, tabId: 123 }), false);
  assert.equal(messages.isInspectRequest({ ...request, requestId: 'email@example.test' }), false);
  assert.equal(messages.isInspectRequest({ ...request, type: 'FILL_FORM' }), false);
  assert.equal(messages.isCurrentRequest({ type: 'PIKO_SCAN_CURRENT', scanId: id('scan', 1), documentId: id('doc', 2) }), true);
});

function background(url = 'chrome://settings') {
  const listeners = {};
  let injections = 0;
  const notices = [];
  const opened = [];
  const panelBehavior = [];
  const chrome = {
    runtime: { id: 'test-extension', getURL: (suffix) => `chrome-extension://test-extension/${suffix}`, onConnect: { addListener() {} }, onMessage: { addListener: (fn) => { listeners.message = fn; } }, sendMessage: async (message) => { notices.push(message); } },
    sidePanel: { setPanelBehavior: async (behavior) => { panelBehavior.push(behavior); }, open: async (options) => { opened.push(options); } },
    action: { onClicked: { addListener: (fn) => { listeners.action = fn; } } },
    tabs: { query: async () => [{ id: 7, url }], sendMessage: async () => {}, onUpdated: { addListener: (fn) => { listeners.updated = fn; } }, onRemoved: { addListener: (fn) => { listeners.removed = fn; } }, onActivated: { addListener: (fn) => { listeners.activated = fn; } } },
    scripting: { executeScript: async () => { injections++; throw new Error('PRIVATE_BROWSER_ERROR'); } },
  };
  const worker = createLoader({ chrome }).call(null, path.join(root, 'background/service-worker.ts'));
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/sidepanel/index.html') };
  return { listeners, sender, worker, notices, opened, panelBehavior, chrome, injections: () => injections };
}

test('restricted schemes and Chrome Web Store cannot trigger injection', async () => {
  for (const url of ['chrome://settings', 'about:blank', 'file:///tmp/example', 'chrome-extension://other/page.html', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test']) {
    const bg = background(url);
    const result = await new Promise((resolve) => bg.listeners.message({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 8) }, bg.sender, resolve));
    assert.equal(result.ok, false); assert.equal(result.error, 'unsupported-page'); assert.equal(bg.injections(), 0);
  }
});

test('injection errors are sanitized and non-panel senders cannot request scans', async () => {
  const bg = background('https://example.test');
  const request = { type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 9) };
  assert.equal(bg.listeners.message(request, { ...bg.sender, url: 'https://example.test', tab: { id: 7 } }, () => assert.fail('Untrusted caller')), undefined);
  assert.equal(bg.injections(), 0);
  const result = await new Promise((resolve) => bg.listeners.message(request, bg.sender, resolve));
  assert.equal(result.error, 'injection-failed'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('a superseded scan request cannot invalidate the newer successful scan', async () => {
  let listener;
  let finishFirst;
  let calls = 0;
  const notices = [];
  const scan = inventory();
  const chrome = {
    runtime: { id: 'test-extension', getURL: (suffix) => `chrome-extension://test-extension/${suffix}`, onConnect: { addListener() {} }, onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async (message) => { notices.push(message); } },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7, url: scan.origin }],
      sendMessage: async (_tab, message) => message.type === 'PIKO_SCAN_DOCUMENT' ? scan : message.type === 'PIKO_SCAN_CURRENT' ? { current: true } : { released: true },
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} },
    },
    scripting: { executeScript: async () => ++calls === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : [{ documentId: 'chrome-document' }] },
  };
  createLoader({ chrome })(path.join(root, 'background/service-worker.ts'));
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/sidepanel/index.html') };
  const first = new Promise((resolve) => listener({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 10) }, sender, resolve));
  await new Promise(setImmediate);
  const second = await new Promise((resolve) => listener({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 11) }, sender, resolve));
  assert.equal(second.ok, true);
  finishFirst([{ documentId: 'chrome-document' }]);
  assert.equal((await first).error, 'stale-scan');
  assert.equal(notices.length, 0);
  listener({ type: 'PIKO_SCAN_STALE', scanId: scan.scanId, documentId: scan.documentId }, { id: chrome.runtime.id, tab: { id: 7 }, frameId: 0, documentId: 'chrome-document' }, () => {});
  assert.equal(notices[0].scanId, scan.scanId);
});


test('lifecycle events still invalidate panel metadata after a worker restart loses its maps', () => {
  const bg = background();
  bg.listeners.updated(7, { status: 'loading' });
  assert.deepEqual(bg.notices.at(-1), { type: 'PIKO_SCAN_INVALIDATED', tabId: 7, scanId: null, reason: 'navigation' });
  bg.listeners.activated({ tabId: 8 });
  assert.deepEqual(bg.notices.at(-1), { type: 'PIKO_SCAN_TAB_ACTIVATED', tabId: 8 });
  bg.listeners.message({ type: 'PIKO_SCAN_STALE', scanId: id('scan', 12), documentId: id('doc', 13) }, { id: bg.sender.id, tab: { id: 7 }, frameId: 0, documentId: 'chrome-document' }, () => {});
  assert.equal(bg.notices.at(-1).scanId, id('scan', 12));
});


test('the toolbar click opens the side panel synchronously with automatic opening disabled', () => {
  const bg = background();
  assert.deepEqual(bg.panelBehavior, [{ openPanelOnActionClick: false }]);
  assert.equal(typeof bg.listeners.action, 'function');
  bg.listeners.action({ id: 7 });
  assert.deepEqual(bg.opened, [{ tabId: 7 }]);
  bg.listeners.action({});
  assert.equal(bg.opened.length, 1);
});

test('permission denial, missing scanner asset and disconnected scanner have distinct safe errors', async () => {
  const bg = background('https://example.test');
  assert.equal(bg.worker.injectionError(new Error('Cannot access contents of url https://private.example.test/secret')), 'activate-extension');
  assert.equal(bg.worker.injectionError(new Error('Could not load file src/content/form-scanner.js')), 'scanner-load-failed');
  assert.equal(bg.worker.injectionError(new Error('PRIVATE_BROWSER_ERROR')), 'injection-failed');
  bg.chrome.scripting.executeScript = async () => [{ documentId: 'chrome-document' }];
  bg.chrome.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
  const result = await new Promise((resolve) => bg.listeners.message({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 14) }, bg.sender, resolve));
  assert.equal(result.error, 'scanner-unavailable');
  assert.equal(JSON.stringify(result).includes('Receiving end'), false);
});

function allowScanner(bg, scan = inventory()) {
  bg.chrome.scripting.executeScript = async () => [{ documentId: 'chrome-document' }];
  bg.chrome.tabs.sendMessage = async (_tabId, message) => message.type === 'PIKO_SCAN_DOCUMENT' ? scan : message.type === 'PIKO_SCAN_CURRENT' ? { current: true } : { released: true };
}

test('withheld tab URLs do not falsely reject a browser-authorized scan', async () => {
  const bg = background();
  bg.chrome.tabs.query = async () => [{ id: 7 }];
  allowScanner(bg);
  const result = await new Promise((resolve) => bg.listeners.message({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 15) }, bg.sender, resolve));
  assert.equal(result.ok, true);
  assert.equal(result.result.inventory.origin, 'https://example.test');
});

test('inspection and freshness checks use the panel window instead of a different focused window', async () => {
  const bg = background();
  const queries = [];
  bg.chrome.tabs.query = async (query) => {
    queries.push(query);
    return query.windowId === 31 ? [{ id: 7 }] : [{ id: 99, url: 'chrome://settings' }];
  };
  allowScanner(bg);
  const result = await new Promise((resolve) => bg.listeners.message({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 16), windowId: 31 }, bg.sender, resolve));
  assert.equal(result.ok, true);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.windowId === 31 && query.currentWindow === undefined));
  assert.equal(messages.isInspectRequest({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 17), windowId: -1 }), false);
  assert.equal(messages.isInspectRequest({ type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 17), windowId: '31' }), false);
});

test('missing URL metadata never bypasses Chrome permission checks or the scanner protocol guard', async () => {
  const bg = background();
  bg.chrome.tabs.query = async () => [{ id: 7 }];
  bg.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of this page'); };
  const request = { type: 'PIKO_SCAN_ACTIVE', requestId: id('request', 18) };
  const denied = await new Promise((resolve) => bg.listeners.message(request, bg.sender, resolve));
  assert.equal(denied.error, 'activate-extension');
  bg.chrome.scripting.executeScript = async () => [{ documentId: 'chrome-document' }];
  bg.chrome.tabs.sendMessage = async () => ({ error: 'unsupported-page' });
  const restricted = await new Promise((resolve) => bg.listeners.message(request, bg.sender, resolve));
  assert.equal(restricted.error, 'unsupported-page');
});
