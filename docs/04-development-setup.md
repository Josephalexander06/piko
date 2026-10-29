# Step 3 development setup and verification

Historical Step 3 baseline: Step 7 supersedes the health-only service, permissions,
and placeholder runtime status below. Use [the current connection guide](08-local-service-connection.md)
for pairing, authentication, the protocol, and current verification commands.

This document records the Step 3 foundation. The extension now has the
[Step 4 synthetic UI workflow](05-extension-ui.md); the service, permissions,
build paths, and installation commands below still apply. References to the
placeholder panel and Step 4 being deferred describe the earlier baseline.

## Scope and preserved work

This step creates a toolbar-launched Chrome side panel and a health-only Python
API. They run independently. Do not download models or follow the later-phase
engine setup in `test/README.md` to run this skeleton.

The Step 2 schemas, specifications, threat model, and fixtures are preserved.
The existing `test/` directory is retained; `tests/` contains Step 3 checks and
points to the original fixtures. The original implementation plan remains in the
root README below the current setup instructions. Its `/health` and `/api/v1/*`
examples are future design references. Step 3 implements only `/v1/health`.

There is no Next.js application or installed Next.js package in this repository.
The existing root agent instructions remain intact; the extension uses Vite.

## Prerequisites and dependency boundaries

- Node.js 20.19+ within Node 20, or Node.js 22.12+; npm; Git.
- Python 3.10+ with `venv` and pip. Python 3.14 is supported by the chosen wheels.
- Chrome 116+ for manual side-panel verification.
- Network access is required for package installation only. No AI runtimes or
  external accounts are needed.

Root `package.json` and lockfile own contract-validation and browser-test tools.
`apps/extension/package.json` and its lockfile own the extension's dependencies;
this is deliberately not an npm workspace. Install both with their own `npm ci`.
Python dependencies live only in `apps/local-service/.venv`. No global Python
package installation or root Node/Python dependency mixing is needed.

`requirements.txt` pins FastAPI, Pydantic, and Uvicorn directly. The latest
`fastapi[standard]` resolution at implementation time included OpenTelemetry
exporters and a cloud CLI with Sentry, conflicting with this project's constraints.
The explicit runtime dependencies avoid those extras. `requirements-dev.txt`
adds HTTPX for local API tests. Transitive Python dependencies are resolved by pip;
this is not a fully locked Python environment.

## Extension setup

From the repository root:

```bash
node --version
npm --version
git --version
npm ci
npm --prefix apps/extension ci
npm run build
npm run dev:extension
```

The official `create-crxjs` React/TypeScript scaffold supplies the React, CRXJS,
Vite, alias, and ZIP packaging configuration. Tailwind's Vite plugin is added
without replacing those plugins. shadcn/ui was initialized with the Radix nova
preset and only button, card, badge, and separator. Its Geist font files are
bundled from npm rather than requested from a font service.

Build outputs for this configuration:

| Purpose | Repository-relative path |
| --- | --- |
| Unpacked development or production extension | `apps/extension/dist/` |
| Generated manifest | `apps/extension/dist/manifest.json` |
| Side panel entry | `apps/extension/dist/src/sidepanel/index.html` |
| Production archive | `apps/extension/release/crx-piko-extension-0.1.0.zip` |

Vite listens on `127.0.0.1:5173` with a strict port. CRXJS writes its development
extension to `dist/`. The manifest explicitly grants localhost HTTP/WebSocket
access and inline development styles only when Vite runs in serve mode, as
CRXJS's worker imports modules from Vite. CRXJS also exposes development assets
for hot reload. The generated development CSP/permissions differ from production.
`npm run build` restores a self-contained production extension with only the
`sidePanel` permission and no host permissions. Do not distribute a dev build.

### Chrome verification

1. Open `chrome://extensions` and enable Developer mode.
2. Choose Load unpacked and select the generated `apps/extension/dist/` folder.
3. Confirm no manifest or worker errors, then pin the toolbar action.
4. Click the icon. Confirm the side panel opens, with the application title,
   Development badge, and “Local AI runtime not connected yet” message.
5. Confirm the voice button is disabled and no website or microphone access is
   requested. The current service status is a fixed placeholder, not a probe.
6. Resize the side panel and check that the content remains readable.
7. Stop Vite, run `npm run build`, reload the extension in `chrome://extensions`,
   and repeat the toolbar check. Production must work without a dev server.

Keep Vite running for development HMR. Manifest or background changes may require
reloading the extension in `chrome://extensions`. If port 5173 is occupied, stop
the conflicting server before restarting; the fixed port keeps CRXJS consistent.
The Vite WebSocket client port is also fixed at 5173 because extension pages do
not have an HTTP port from which the client can infer that connection.

CRXJS 2.4 currently uses Vite's deprecated `server.hmr` configuration and Vite 8
prints a warning recommending `server.ws`. This upstream warning does not block
startup or production builds; no installed dependency files are patched.

## Python setup and launch

Linux/macOS, starting at the repository root:

```bash
cd apps/local-service
python3 --version
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m app
```

Windows PowerShell, starting at the repository root:

```powershell
cd apps/local-service
py --version
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m app
```

The direct virtual-environment executable avoids activation-policy changes.
`requirements.txt` suffices to run the service; use `requirements-dev.txt` for
tests. `python -m app` fixes the host to IPv4 loopback and port 8765, disables
access logs, and enables development reload. Use Ctrl+C to stop it.

An equivalent explicit launch from `apps/local-service` is:

```bash
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8765 --no-access-log
```

Do not change the host to `0.0.0.0`. There is no authentication in this step.
The API only returns static health metadata and has no model proxy or data
processing routes. CORS middleware is absent. The extension never contacts it.
OpenAPI JSON remains available at `/openapi.json`; `/docs` and `/redoc` are disabled
so no interactive documentation assets are loaded from a public CDN.

## Live API and listener verification

In a second terminal at the repository root:

```bash
python3 scripts/verify-service.py
```

PowerShell alternatives:

```powershell
py scripts/verify-service.py
Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/health" | ConvertTo-Json
Get-NetTCPConnection -LocalPort 8765 -State Listen
```

The health checker requires the exact four-field response shown in the root
README. A successful HTTP response alone does not prove loopback-only binding.
Verify the listener separately:

```bash
# Linux
ss -ltnp 'sport = :8765'
# macOS
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

The local address must be `127.0.0.1:8765`, never `0.0.0.0:8765`, `*:8765`,
or a LAN address. On Windows the LocalAddress column must be `127.0.0.1`.

If another application owns port 8765, leave it running and use an alternate
loopback port for development. From `apps/local-service`:

```bash
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8766 --no-access-log
```

Then run `python3 scripts/verify-service.py --port 8766` from the root and inspect
the listener on port 8766. `python -m app` continues to use the required default
port 8765; it intentionally fails if that port is occupied.

## Automated checks

From the root after installation:

```bash
npm run build
npm run typecheck
npm run lint
npm test
apps/local-service/.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
apps/local-service/.venv/bin/python -m pip check
```

Use `.\apps\local-service\.venv\Scripts\python.exe` for the Python commands on
Windows. `npm test` runs the preserved contract suite and extension checks;
the latter inspect the generated **production** manifest, so build first.
Date-time formats in the original schemas are validated through `ajv-formats`.
These checks do not implement semantic form validation from later steps.

Optional browser smoke test (requires a local Chromium binary):

```bash
npx playwright install chromium
npm run test:browser
```

The browser test loads the production extension, checks its worker and Chrome's
stored panel behavior, renders the bundled panel, and checks narrow layouts and
absence of HTTP requests. Set `PIKO_CHROMIUM_PATH` to a compatible Chromium
executable to use an existing local installation. Browser downloads are optional
development tooling. The smoke test cannot click Chrome's native toolbar;
complete the manual checklist above for that acceptance gate.

## Repository hygiene and baseline

Builds, release archives, Node dependencies, virtual environments, Python caches,
local environment files, models, voices, and recordings are ignored. Keep any
future vendored runtime source outside this repository until an explicit vendor
or submodule decision is made.

Inspect changes before making the requested baseline commit:

```bash
git diff --check
git diff
git status --short
```

After automated checks and manual Chrome toolbar verification pass, stage only
the intended source, documentation, and lockfiles, review the staged diff, then:

```bash
git commit -m "chore: scaffold local-first application"
```

No Step 4 UI flow, runtime integration, model downloads, profiles, or form
features are part of this baseline.

## Implementation verification — 2026-10-29

- Production extension build, TypeScript check, and ESLint passed.
- Preserved contract suite and three extension boundary/worker checks passed.
- Four Python tests and `pip check` passed.
- Chromium loaded the production extension and confirmed stored toolbar panel
  behavior. The panel rendered at 280, 360, and 480 pixels without browser errors
  or HTTP requests; a screenshot was visually inspected.
- A development extension also loaded through CRXJS/Vite on port 5173 without
  browser errors after the development CSP and WebSocket configuration fixes.
- The live health API returned the exact required JSON on `127.0.0.1:8766`;
  `ss` confirmed a loopback-only listener. Port 8765 was already occupied by a
  separate voice-demo process, which was preserved. The launcher test verifies
  that `python -m app` still requests `127.0.0.1:8765` by default.
- Native Chrome toolbar clicking remains a manual acceptance check. The
  automated browser check verifies configuration and panel rendering only.
- CRXJS's Vite HMR deprecation warning remains an upstream limitation.
