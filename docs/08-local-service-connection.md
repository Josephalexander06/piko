# Step 7 — Authenticated local companion connection

The worker can check service health, exchange a temporary code for an
origin-bound bearer session, retrieve capabilities, ping, and revoke that
session. The existing scanner and approval-gated filling engine remain
independent. Step 8 adds authenticated local audio transcription; see the
[voice guide](09-local-voice-input.md). Step 9 adds authenticated interpretation
of explicitly submitted answers and eligible metadata; see the
[Qwen guide](10-local-qwen-interpretation.md). Step 10 adds optional authenticated Piper synthesis; see the
[speech guide](11-local-piper-speech.md). Telemetry and cloud-proxy endpoints
remain absent.

## Start and pair

From the repository root in Windows PowerShell:

```powershell
py -m venv apps/local-service/.venv
.\apps\local-service\.venv\Scripts\python.exe -m pip install -r apps/local-service/requirements-dev.txt
npm ci
npm --prefix apps/extension ci
npm run build
```

Start the companion in a separate terminal:

```powershell
cd apps/local-service
.\.venv\Scripts\python.exe -m app
```

On Linux/macOS, use `.venv/bin/python` in place of `.venv\Scripts\python.exe`.
The launcher fixes IPv4 loopback **127.0.0.1:8765**, uses one process, disables
automatic reload and access logs, and does not trust forwarded client headers.
Do not run multiple workers, change the host, or redirect the startup terminal
to a log file: the initial pairing code is printed there exactly once.

Reload the unpacked extension at `apps/extension/dist` in `chrome://extensions`
and accept its updated loopback and storage permissions. Open the side panel,
expand **Local service connection**, and choose **Check service**. This verifies
readiness and protocol compatibility, not authentication or model readiness.
Enter the terminal's 16-character code and choose **Pair extension**. The field
is masked and cleared when submitted; pairing is never retried automatically.

Use **Authenticated ping**, **Check capabilities**, and **Disconnect service**.
After disconnect, code consumption, five-minute code expiry, or service restart,
obtain a new code by restarting the service. No re-pairing or replacement session
is silently created. A session expires after at most 12 hours.

If your Chrome version presents a local-network access prompt, review and grant
it only for this extension and local service. Do not disable browser security
features. A failure is reported as unavailable rather than assumed healthy.

## Protocol version 1

The existing health JSON adds `protocol_version: 1`; update older health clients
accordingly. The application and extension package versions are independent
from the protocol version. API models reject extra keys and coerced types.

| Method / path | Authentication | Result |
| --- | --- | --- |
| GET `/v1/health` | None; browser origins are still validated | Readiness, service version, `inference: local_ollama` |
| POST `/v1/pair` | Correct unconsumed startup code + valid extension Origin | `protocol_version`, random `token`, Unix-second `expires_at` |
| GET `/v1/capabilities` | Bearer token + exact paired Origin | Transcription: `ready` or `unavailable`; inference: `ready` or `unavailable`; speech synthesis: `ready` or `unavailable` with safe detail |
| POST `/v1/transcribe` | Bearer token + exact paired Origin | Step 8 bounded audio upload and local transcription |
| POST `/v1/interpret` | Bearer token + exact paired Origin | Step 9 bounded metadata + edited answer; validated proposals only |
| POST `/v1/synthesize` | Bearer token + exact paired Origin | Step 10 bounded plain assistant text; bounded WAV audio |
| GET `/v1/ping` | Bearer token + exact paired Origin | `protocol_version: 1`, `status: ok` |
| DELETE `/v1/session` | Bearer token + exact paired Origin | Revoke token, `status: disconnected` |

Pair request: `{ "protocol_version": 1, "code": "<terminal code>" }`.
Authentication uses `Authorization: Bearer <session token>`, never URLs or query
parameters. The additional DELETE route is necessary to implement real server
revocation rather than just hiding a still-valid token in the panel.

Only exact `chrome-extension://[a-p]{32}` origins are accepted. Pairing binds the
session to that exact origin; even another extension with the token is rejected.
Chrome can omit the browser Origin header on privileged extension GET requests.
The worker therefore includes `X-Piko-Extension-Origin`, derived from
`chrome.runtime.getURL`, on every request. When Origin is present it must be a
valid extension origin and agree with that declaration. Without Origin, the
declaration is required except for CLI health probes. A webpage Origin is always
rejected even when the declaration names a valid extension. Both headers can be
forged by a local program, so origin validation and CORS are not substitutes for
the independently random bearer token. CORS allows only extension origins,
GET/POST/DELETE, Content-Type, Authorization and X-Piko-Extension-Origin, without cookies or credentials.

All routes reject non-loopback clients, non-loopback Host headers, duplicate
security headers, query strings, unexpected request bodies, oversized headers,
and unsupported media types. Connection routes allow at most 512 body bytes
(including streamed bodies), with a three-second receive deadline. Step 8's
authenticated audio route has its own bounded multipart policy. Step 9
interpretation accepts at most 128 KiB of authenticated JSON; synthesis accepts
at most 8 KiB. Validation errors never
echo submitted values. Responses are `no-store`. Model, interactive documentation,
and OpenAPI HTTP routes are absent.

The code has 64 random bits, expires after five minutes, and is consumed before
issuing a token. Five failed pairing attempts in a rolling 60-second window
trigger a global limit, including malformed validated requests. Changing origin
does not reset it. Token validation stores only SHA-256 digests and compares
them in constant time. Server state is in memory and cleared on lifespan shutdown
or restart; no previous token or code survives. Expiry uses a monotonic clock.

## Extension boundary and connection states

`background/connection-manager.ts` owns all HTTP and credential access. Its
endpoint list and service address are fixed; messages cannot supply URLs,
headers, tokens, model names, form fields, or arbitrary bodies. The existing
panel-sender check and strict message guards protect worker routing. Content
scripts and unrelated extension pages cannot request connection actions.

The production manifest adds `storage` and `http://127.0.0.1:8765/*`, and the
production CSP permits only that exact loopback origin in addition to bundled
assets. The fixed worker endpoint list and CSP independently enforce the service
address and port. No ordinary website host access is added.
Development retains the existing Vite-only localhost exceptions.

The raw token lives only in `chrome.storage.session`, with its origin, expiry,
and a revocation flag. Access level is explicitly `TRUSTED_CONTEXTS`, excluding
content scripts. Chrome's API also trusts extension pages; this is not a
worker-only storage ACL. The panel implementation never reads that storage and
never receives tokens in messages or renders them. No credential is stored in
localStorage, IndexedDB, `chrome.storage.local`, or sync storage.

Unpaired status does not make background HTTP requests. Explicit health checks
show **available, not paired**. Stored credentials must pass an authenticated
request before **paired** is shown after a worker or panel restart. Paired
sessions are rechecked every 30 seconds and at local expiry; the UI shows the
last verification time. A server restart is detected on the next authenticated
check, clears the stored token, and shows **expired**. Reachability is a bounded
observation, not a permanent guarantee of connectivity.

Requests have three-second abort timeouts, no redirects, no cookies, no cache,
bounded 4 KB responses, exact response-shape checks, and explicit protocol checks.
Unavailable, timeout, rejected code, rate limit, expired session, origin mismatch,
invalid response, and protocol mismatch have distinct safe messages. Pairing is
serialized and existing sessions cannot trigger duplicate pair requests.

Disconnect marks the credential **revocation only** before sending DELETE. When
the server confirms revocation (or says the token is already invalid), storage
is cleared. If confirmation fails, the UI says so and retains only that temporary
revocation credential. It cannot be used for ping, capabilities, or pairing;
subsequent connection actions retry DELETE. Keep the browser session open to
finish revocation or restart the companion. Closing the browser before an offline
revocation completes can leave the server token alive until expiry/restart.

This development authentication model cannot protect against an attacker who
can read the running companion process, its memory, the startup terminal, or
trusted extension code/state. Loopback is a network boundary, not an OS-user
isolation boundary. No credentials or personal payloads are logged by the app.

## Verification

```powershell
.\apps\local-service\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
npm run typecheck
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

The connection browser suite starts and stops its own real Python companion on
8765. Keep that port free; it never stops an existing user service. It installs
the real production extension using Chrome's test-only CDP extension-loading
API, without adding host permissions. `PIKO_PYTHON_PATH` can select another venv
interpreter. To test installed Chrome explicitly on Windows:

```powershell
$env:PIKO_CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npx playwright test tests/connection.browser.spec.cjs
```

API tests cover lifecycle initialization, expiry/restart/revocation, one-session
and rate policies, origin and bearer checks, CORS, malformed/oversized requests,
strict capabilities, secret-safe errors/logging, unsupported routes, and the
loopback launcher. Worker tests cover sender/message boundaries, fixed endpoints,
timeouts, invalid protocols/responses, session restoration, no secret UI messages,
and offline revocation. Browser tests exercise the actual worker-to-FastAPI flow,
masked/cleared codes, session storage and content-script exclusion, restart,
revocation, unavailable/timeout handling, no panel HTTP calls or persistent
storage, and no form/audio payloads. Manual browser prompt behavior and unrelated
websites are separate checks, not certified by these fixtures.

Step 7 baseline verified on Windows on 2026-10-30: 23 Python tests, 51 JavaScript tests plus the
contract harness, explicit TypeScript check, lint, production build, five real
connection browser tests in installed Chrome 156, and all 18 existing browser
regressions in Edge 156 passed. The tests leave no companion process running.

Implementation references: [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
[Chrome session storage](https://developer.chrome.com/docs/extensions/reference/api/storage),
[FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), and
[FastAPI CORS](https://fastapi.tiangolo.com/tutorial/cors/).
