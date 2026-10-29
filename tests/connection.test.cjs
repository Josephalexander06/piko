const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const createLoader = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname, '../apps/extension/src');
const origin = `chrome-extension://${'a'.repeat(32)}`;
const token = 'T'.repeat(43);
const code = '0123456789abcdef';
const caps = { protocol_version: 1, inference: 'not_integrated', transcription: 'not_integrated', speech_synthesis: 'not_integrated' };
const health = { protocol_version: 1, status: 'ok', service: 'local-voice-form-assistant', version: '0.1.0', inference: 'not_integrated' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup() {
  const data = {};
  const calls = [];
  const levels = [];
  let now = 1_800_000_000_000;
  let impl = async (url) => {
    if (url.endsWith('/health')) return json(health);
    if (url.endsWith('/pair')) return json({ protocol_version: 1, token, expires_at: now / 1000 + 43200 });
    if (url.endsWith('/capabilities')) return json(caps);
    return json({ protocol_version: 1, status: url.endsWith('/session') ? 'disconnected' : 'ok' });
  };
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: (file) => `${origin}/${file}` }, storage: { session: {
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (value) => Object.assign(data, structuredClone(value)),
    remove: async (key) => { delete data[key]; },
    setAccessLevel: async (level) => { levels.push(level); },
  } } };
  const http = async (url, options) => { calls.push({ url, options }); return impl(url, options); };
  const load = createLoader({ chrome, fetch: http });
  const { ConnectionManager } = load(path.join(root, 'background/connection-manager.ts'));
  const guards = load(path.join(root, 'features/local-service/connection.validation.ts'));
  const { SESSION_KEY } = load(path.join(root, 'features/local-service/connection.types.ts'));
  const manager = new ConnectionManager(http, () => now, 20);
  let sequence = 0;
  const request = (type, extra = {}) => ({ type: `PIKO_SERVICE_${type}`, requestId: `request_${String(++sequence).padStart(32, '0')}`, ...extra });
  const act = (type, extra) => manager.handle(request(type, extra));
  return { manager, ConnectionManager, chrome, data, calls, levels, guards, SESSION_KEY, act, request, setHttp: (value) => { impl = value; }, advance: (value) => { now += value; } };
}
test('strict message contracts accept only supported actions, exact pairing codes and no form data, URLs or tokens', () => {
  const s = setup();
  assert.equal(s.guards.isConnectionRequest(s.request('PAIR', { code })), true);
  for (const change of [{ code: 123 }, { code: code + 'x' }, { code: [code] }, { code, token }, { code, url: 'https://example.test' }, { code, formValues: 'PRIVATE' }]) assert.equal(s.guards.isConnectionRequest(s.request('PAIR', change)), false);
  assert.equal(s.guards.isConnectionRequest(s.request('HEALTH', { url: 'https://example.test' })), false);
});
test('status without credentials makes no HTTP requests; health alone does not claim pairing', async () => {
  const s = setup();
  assert.equal((await s.act('STATUS')).state.status, 'disconnected'); assert.equal(s.calls.length, 0);
  assert.equal((await s.act('HEALTH')).state.status, 'available');
  assert.deepEqual(s.levels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});
test('pair stores only session credentials, sends only the code and returns no token or code to the UI', async () => {
  const s = setup(); const response = await s.act('PAIR', { code });
  assert.equal(response.ok, true); assert.equal(response.state.status, 'paired');
  assert.equal(s.guards.isConnectionState(response.state), true);
  assert.equal(s.data[s.SESSION_KEY].token, token);
  assert.equal(s.data[s.SESSION_KEY].origin, origin);
  assert.equal(JSON.stringify(response).includes(token), false); assert.equal(JSON.stringify(response).includes(code), false);
  assert.deepEqual(JSON.parse(s.calls[0].options.body), { protocol_version: 1, code });
  assert.ok(s.calls.every(({ url, options }) => url.startsWith('http://127.0.0.1:8765/v1/') && !url.includes(token) && options.redirect === 'error' && options.cache === 'no-store' && options.credentials === 'omit'));
  assert.equal(s.calls[1].options.headers.Authorization, `Bearer ${token}`);
  await s.act('PAIR', { code });
  assert.equal(s.calls.filter(({ url }) => url.endsWith('/pair')).length, 1);
});
test('restored sessions must authenticate before reporting paired; invalid sessions clear storage', async () => {
  const s = setup(); await s.act('PAIR', { code });
  const fresh = new s.ConnectionManager(async () => json({ error: 'invalid_session' }, 401), () => 1_800_000_000_000);
  const response = await fresh.handle(s.request('STATUS'));
  assert.equal(response.state.status, 'expired'); assert.equal(s.data[s.SESSION_KEY], undefined);
});
test('local expiry fails closed before an authenticated HTTP request', async () => {
  const s = setup(); await s.act('PAIR', { code }); const count = s.calls.length; s.advance(43200_000);
  assert.equal((await s.act('PING')).state.error, 'session-expired'); assert.equal(s.calls.length, count); assert.equal(s.data[s.SESSION_KEY], undefined);
});
test('corrupt or wrong-origin storage is discarded', async () => {
  const s = setup(); s.data[s.SESSION_KEY] = { token, origin: 'chrome-extension://' + 'b'.repeat(32), expiresAt: 1_900_000_000_000, pendingRevocation: false };
  assert.equal((await s.act('STATUS')).state.status, 'disconnected'); assert.equal(s.calls.length, 0); assert.equal(s.data[s.SESSION_KEY], undefined);
});
test('failed pairing is explicit and never retried', async () => {
  for (const [status, expected] of [[401, 'pairing-rejected'], [429, 'rate-limited'], [403, 'unsupported-origin'], [426, 'unsupported-protocol']]) {
    const s = setup(); s.setHttp(async () => json({ error: 'safe_error' }, status));
    const response = await s.act('PAIR', { code }); assert.equal(response.state.error, expected); assert.equal(s.calls.length, 1); assert.equal(s.data[s.SESSION_KEY], undefined);
  }
});
test('network failure and abort timeout are distinct and sanitized', async () => {
  const s = setup(); s.setHttp(async () => { throw Error('PRIVATE network details'); });
  assert.equal((await s.act('HEALTH')).state.error, 'service-unavailable');
  s.setHttp((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('PRIVATE aborted')))));
  const response = await s.act('HEALTH'); assert.equal(response.state.error, 'timeout'); assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
});
test('invalid JSON, oversized, contradictory and unknown protocol responses fail closed', async () => {
  for (const [reply, expected] of [[() => json({ ...health, protocol_version: 2 }), 'unsupported-protocol'], [() => json({ ...health, inference: 'ready' }), 'invalid-response'], [() => json({ ...health, token }), 'invalid-response'], [() => json({ data: 'X'.repeat(5000) }), 'invalid-response'], [() => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), 'invalid-response']]) {
    const s = setup(); s.setHttp(async () => reply()); assert.equal((await s.act('HEALTH')).state.error, expected);
  }
});
test('disconnect revokes on server before deleting client credential', async () => {
  const s = setup(); await s.act('PAIR', { code });
  const result = await s.act('DISCONNECT'); assert.equal(result.state.status, 'disconnected'); assert.equal(s.data[s.SESSION_KEY], undefined);
  assert.equal(s.calls.at(-1).options.method, 'DELETE'); assert.ok(s.calls.at(-1).url.endsWith('/session'));
});
test('unconfirmed revocation is session-only, blocks reuse and pairing, then retries DELETE', async () => {
  const s = setup(); await s.act('PAIR', { code });
  s.setHttp(async () => { throw Error('offline'); });
  const disconnected = await s.act('DISCONNECT'); assert.equal(disconnected.state.error, 'disconnect-unconfirmed'); assert.equal(disconnected.state.disconnectPending, true);
  assert.equal(s.data[s.SESSION_KEY].pendingRevocation, true);
  const count = s.calls.length; await s.act('PAIR', { code });
  assert.equal(s.calls.length, count + 1); assert.ok(s.calls.at(-1).url.endsWith('/session'));
  s.setHttp(async () => json({ error: 'invalid_session' }, 401));
  assert.equal((await s.act('STATUS')).state.status, 'disconnected'); assert.equal(s.data[s.SESSION_KEY], undefined);
});
test('concurrent pairing is rejected and cannot issue duplicate pair requests', async () => {
  const s = setup(); let release;
  s.setHttp(() => new Promise((resolve) => { release = () => resolve(json({ error: 'pairing_rejected' }, 401)); }));
  const first = s.act('PAIR', { code }); await new Promise(setImmediate);
  const second = await s.act('PAIR', { code }); assert.equal(second.state.error, 'busy'); assert.equal(s.calls.length, 1);
  release(); await first;
});
test('service-worker routing rejects webpage content scripts, unrelated extension pages and extra payloads', () => {
  const listeners = {};
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: (suffix) => `${origin}/${suffix}`, onMessage: { addListener: (fn) => { listeners.message = fn; } } }, sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: { addListener() {} } }, tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} } } };
  createLoader({ chrome, fetch: () => assert.fail('Unexpected HTTP') })(path.join(root, 'background/service-worker.ts'));
  const request = { type: 'PIKO_SERVICE_PAIR', requestId: 'request_' + '0'.repeat(32), code };
  for (const sender of [{ id: chrome.runtime.id, tab: { id: 7 }, url: 'https://example.test' }, { id: 'other', url: `${origin}/src/sidepanel/index.html` }, { id: chrome.runtime.id, url: `${origin}/other.html` }]) assert.equal(listeners.message(request, sender, () => assert.fail('Untrusted sender')), undefined);
  assert.equal(listeners.message({ ...request, formValues: 'PRIVATE' }, { id: chrome.runtime.id, url: `${origin}/src/sidepanel/index.html` }, () => assert.fail('Extra payload')), undefined);
});
