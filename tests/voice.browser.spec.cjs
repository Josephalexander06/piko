const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Opt in: uses the operator's local executables/model and a fake microphone,
// never a physical microphone. The bundled JFK sample comes from Whisper.cpp.
test.skip(process.env.PIKO_TEST_REAL_VOICE !== '1', 'Requires configured local Whisper/FFmpeg and the official sample');
const root = path.resolve(__dirname, '..');
const serviceDirectory = path.join(root, 'apps/local-service');
const python = process.env.PIKO_PYTHON_PATH || path.join(serviceDirectory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const base = 'http://127.0.0.1:8765';
let service, context, panel, worker, temporary, requests, errors;

async function portFree() {
  const probe = net.createServer();
  return new Promise(resolve => {
    probe.once('error', () => resolve(false));
    probe.listen(8765, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function startService() {
  expect(await portFree(), 'Leave an existing user service untouched').toBe(true);
  service = spawn(python, ['-m', 'app'], { cwd: serviceDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
  const code = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(Error('Companion startup timed out')), 10000);
    service.once('error', () => { clearTimeout(timer); reject(Error('Companion launch failed')); });
    service.once('exit', () => { clearTimeout(timer); reject(Error('Companion exited before startup')); });
    service.stderr.on('data', () => {});
    service.stdout.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-2048);
      const match = /Piko pairing code[^\n]*: ([a-f0-9]{16})/.exec(buffer);
      if (match) { clearTimeout(timer); buffer = ''; resolve(match[1]); }
    });
  });
  await expect.poll(async () => { try { return (await fetch(`${base}/v1/health`)).status; } catch { return 0; } }).toBe(200);
  return code;
}
async function openPanel(audioPath) {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, executablePath: process.env.PIKO_CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'apps/extension/dist') });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  context.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push({ url: request.url(), method: request.method(), worker: Boolean(request.serviceWorker()), type: request.headers()['content-type'] });
  });
  panel = await context.newPage();
  panel.on('pageerror', error => errors.push(error.message));
  await panel.addInitScript(() => {
    window.__streams = []; window.__captures = 0; window.__forbidden = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__captures++;
      const stream = await capture(constraints); window.__streams.push(stream); return stream;
    };
    for (const [object, name] of [[window, 'fetch'], [XMLHttpRequest.prototype, 'open'], [Storage.prototype, 'setItem'], [indexedDB, 'open']]) {
      object[name] = () => { window.__forbidden.push(name); throw Error('Panel bypassed worker or persisted data'); };
    }
  });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
  await panel.getByText('Local service connection', { exact: true }).click();
  await panel.getByLabel('Temporary pairing code').fill(await startService());
  await panel.getByRole('button', { name: 'Pair extension', exact: true }).click();
  await expect(panel.getByText('Companion paired', { exact: true })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Local service capabilities' })).toContainText('Transcription: ready');
  await panel.getByRole('button', { name: 'Load demo form', exact: true }).click();
  await panel.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start voice recording', exact: true })).toBeEnabled();
  expect(await panel.evaluate(() => window.__captures)).toBe(0);
}
test.beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'piko-voice-browser-'));
  requests = []; errors = [];
});
test.afterEach(async () => {
  try {
    if (panel && !panel.isClosed()) {
      expect(await panel.evaluate(() => window.__forbidden)).toEqual([]);
      expect(await panel.evaluate(() => window.__streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(requests.every(request => request.worker && request.url.startsWith(`${base}/v1/`))).toBe(true);
    expect(await fs.readdir(temporary)).toEqual([]);
    if (worker) {
      expect(await worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)))).toEqual(['piko.localService.session.v1']);
      expect(await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)))).toEqual([]);
    }
  } finally {
    await context?.close(); context = undefined; panel = undefined; worker = undefined;
    if (service) { const exited = once(service, 'exit'); service.kill(); await exited; service = undefined; await expect.poll(portFree).toBe(true); }
    // Only remove the exact directory created by this test under the OS temp root.
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('piko-voice-browser-')) throw Error('Unexpected test cleanup path');
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('Chrome MediaRecorder sends real speech through the worker and local Whisper; acceptance only adds edited conversation text', async ({}, info) => {
  await openPanel(path.resolve(process.env.PIKO_VOICE_SAMPLE || path.join(root, 'vendor/whisper.cpp/samples/jfk.wav')));
  const target = await context.newPage();
  await target.setContent('<form><input aria-label="Untouched field" value="original"><button>Submit</button></form><script>window.submitted=false;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submitted=true}</script>');
  await panel.getByRole('button', { name: 'Start voice recording', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await panel.waitForTimeout(6000);
  await panel.getByRole('button', { name: 'Stop recording', exact: true }).click();
  expect(await panel.evaluate(() => window.__streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  const transcript = panel.getByLabel('Edit your transcript');
  await expect(transcript).toBeVisible({ timeout: 30000 });
  await expect(transcript).toHaveValue(/fellow|Americans|country|ask/i);
  await panel.screenshot({ path: info.outputPath('voice-transcript-review.png'), fullPage: true });
  expect(requests.filter(request => request.url.endsWith('/transcribe'))).toEqual([{ url: `${base}/v1/transcribe`, method: 'POST', worker: true, type: expect.stringContaining('multipart/form-data; boundary=') }]);
  await expect(panel.getByRole('button', { name: 'Review proposed values', exact: true })).toBeDisabled();
  await transcript.fill('Edited synthetic voice answer.');
  await panel.getByRole('button', { name: 'Accept transcript', exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).toContainText('Edited synthetic voice answer.');
  await expect(panel.getByRole('button', { name: 'Review proposed values', exact: true })).toBeDisabled();
  await expect(target.getByLabel('Untouched field')).toHaveValue('original');
  expect(await target.evaluate(() => window.submitted)).toBe(false);
  for (const width of [280, 360, 480]) { await panel.setViewportSize({ width, height: 800 }); expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await panel.screenshot({ path: info.outputPath('voice-transcript-accepted.png'), fullPage: true });
});

test('recording discard releases real Chrome microphone tracks without an upload', async () => {
  await openPanel(path.resolve(process.env.PIKO_VOICE_SAMPLE || path.join(root, 'vendor/whisper.cpp/samples/jfk.wav')));
  await panel.getByRole('button', { name: 'Start voice recording', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Discard recording', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start voice recording', exact: true })).toBeVisible();
  expect(requests.some(request => request.url.endsWith('/transcribe'))).toBe(false);
});

test('microphone permission rejection stays local and displays a safe retry', async () => {
  await openPanel(path.resolve(process.env.PIKO_VOICE_SAMPLE || path.join(root, 'vendor/whisper.cpp/samples/jfk.wav')));
  await panel.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('private device detail', 'NotAllowedError'); }; });
  await panel.getByRole('button', { name: 'Start voice recording', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Microphone access is blocked');
  expect(await panel.content()).not.toContain('private device detail');
  expect(requests.some(request => request.url.endsWith('/transcribe'))).toBe(false);
});

test('the real microphone timer stops within 20 seconds and never accepts text automatically', async () => {
  await openPanel(path.resolve(process.env.PIKO_VOICE_SAMPLE || path.join(root, 'vendor/whisper.cpp/samples/jfk.wav')));
  await panel.getByRole('button', { name: 'Start voice recording', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop recording', exact: true })).toBeHidden({ timeout: 22000 });
  expect(await panel.evaluate(() => window.__streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await expect(panel.getByLabel('Edit your transcript')).toBeVisible({ timeout: 15000 });
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).not.toContainText('Transcript added.');
  await expect(panel.getByRole('button', { name: 'Review proposed values', exact: true })).toBeDisabled();
});

test('cancelling a submitted recording aborts processing and leaves no temporary audio or accepted text', async () => {
  await openPanel(path.resolve(process.env.PIKO_VOICE_SAMPLE || path.join(root, 'vendor/whisper.cpp/samples/jfk.wav')));
  await panel.getByRole('button', { name: 'Start voice recording', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await panel.waitForTimeout(1500);
  const upload = context.waitForEvent('request', { predicate: request => request.url() === `${base}/v1/transcribe` });
  await panel.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await upload;
  await panel.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Start voice recording', exact: true })).toBeVisible();
  await panel.waitForTimeout(500);
  await expect.poll(async () => fs.readdir(temporary)).toEqual([]);
  await expect(panel.getByLabel('Edit your transcript')).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Conversation messages' })).not.toContainText('Transcript added.');
});
