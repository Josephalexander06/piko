# Step 9 — Local Qwen interpretation

The existing FastAPI companion now exposes authenticated `POST /v1/interpret`.
The extension sends an explicitly submitted edited answer and metadata from its
current eligible scan. Ollama produces proposals; independent application code
validates them. The existing editable review controls show the values with all
include/overwrite boxes unselected. Interpretation never creates a review grant,
approves a batch, writes the DOM, or submits a form.

## Start locally

No model is downloaded automatically. Check the operator-managed Ollama install:

```bash
ollama --version
ollama list
# Only if you choose to install the missing model:
ollama pull qwen3.5:2b
```

From the repository root (Linux/macOS):

```bash
apps/local-service/.venv/bin/python -m pip install -r apps/local-service/requirements-dev.txt
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen3.5:2b
export OLLAMA_TIMEOUT_SECONDS=60
export OLLAMA_MAX_CONCURRENCY=1
cd apps/local-service
.venv/bin/python -m app
```

Windows PowerShell, before starting the existing service:

```powershell
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen3.5:2b"
$env:OLLAMA_TIMEOUT_SECONDS = "60"
$env:OLLAMA_MAX_CONCURRENCY = "1"
cd apps/local-service
.\.venv\Scripts\python.exe -m app
```

These are also the defaults. Configuration comes only from the service's process
environment; `.env.example` is documentation, not automatically loaded.
The endpoint must be an explicit HTTP loopback IP and port, with no credentials,
path, query or fragment. Model names need a validated `name:tag`; cloud names are
rejected. The capability check and each generation check `/api/tags` and
`/api/show`, requiring the exact installed name and local model architecture and
rejecting remote model metadata. HTTP proxies, redirects, tools, external
endpoints, automatic pulls and cloud fallbacks are disabled. A concurrency other
than one is rejected in this initial version; a second job receives
`interpretation-busy`, rather than entering an unbounded queue.

Build with `npm run build` (extension version 0.2.0), reload `apps/extension/dist` in `chrome://extensions`,
restart the companion, and pair with its new terminal code. There are no new
extension permissions or direct extension-to-Ollama connections. Health reports
`inference: local_ollama` for integration status; authenticated capabilities report
`inference: ready` or `unavailable` after checking the configured model.

## Use the current form

1. Open a normal form tab, click Piko's toolbar icon, then **Inspect this page**.
2. Under **Prepare answers with local Qwen**, record and edit a transcript or type
   into **Edited answer for this form**. Accepting voice text only copies it into
   that editor. Recording/transcription and interpretation are separate actions.
3. Click **Interpret edited answer**. Review proposals and source evidence,
   clarification questions, and the required-information queue. Errors preserve
   the edited text for correction and retry. Cancellation discards late results.
4. Edit values, explicitly select fields, and use the existing exact-batch review
   and approval flow only when ready. Existing answers still require independent
   per-field overwrite permission. There is no automatic filling.

Manual answers remain available without Ollama. **Discard interpreted answers**
clears the text and untouched model drafts; manual corrections are preserved.
Clearing/rescanning/unmounting cancels interpretation. Navigation, mutations,
tab changes, worker restart and session revocation reject obsolete results.

## Canonical contracts

`app/schemas/interpret.py` is the canonical strict Pydantic definition. Export
both checked-in JSON Schemas and TypeScript types from it:

```bash
apps/local-service/.venv/bin/python scripts/generate-interpret-contracts.py
apps/local-service/.venv/bin/python scripts/generate-interpret-contracts.py --check
```

On Windows use `.\apps\local-service\.venv\Scripts\python.exe`.
The build generates CSP-safe Ajv validators from those schemas without runtime
code generation. The fill engine's TypeScript `FillValue` aliases the generated
`InterpretTarget`. Contract drift is tested. Original Step 2 fixtures have been
migrated to the new wire shape; generic `value`/`confidence` proposals are no
longer accepted.

Request: `scanId`, `transcript`, `knownFacts`, `fields` (all required; no extras).
Fields contain `fieldId`, `label`, `type`, `required`, `options`, `constraints`.
Options have opaque `optionId` and label only. Facts have `factId` and `text` and
must be explicitly approved/provided in this session. The current extension
sends `knownFacts: []`; it does not silently promote model proposals to facts or
retain a profile. API callers can supply approved facts for this one request.

Response: `scanId`, `updates`, `clarifications`, `missingFields`. Every update
contains `fieldId`, `target`, and exact quoted `evidence` from the edited
transcript or supplied fact. Targets match Step 6:

```json
{"kind":"text","value":"Alex Thomas"}
{"kind":"email","value":"alex@example.test"}
{"kind":"select","optionId":"option_00000000000000000000000000000001"}
{"kind":"radio","optionId":"option_00000000000000000000000000000002"}
{"kind":"checkbox","checked":true}
```

Text kinds are `text`, `email`, `tel`, `number`, `date`, `textarea`; number/date
values remain strings as in native inputs. Dates require certain complete ISO
values. Evidence is `{source: "transcript", factId: null, quote: "exact excerpt"}`
or `{source: "fact", factId: "fact_…", quote: "exact excerpt"}`.

Limits: 128 KiB request body before parsing, 4,096 transcript characters,
100 fields, 50 options per field / 500 options total, 50 approved facts,
1,024 characters per proposed text value, 100 updates, 10 clarifications.
No eligible fields yields an empty result without calling inference. Authentication
happens before reading the interpretation body, including streamed bodies.
Malformed/duplicate JSON properties and unexpected properties are rejected.

The worker binds input metadata to its current scan, excludes disabled options,
and checks document freshness before and after the HTTP call. The server builds
field-specific output grammar with exact field/option IDs and kind restrictions,
then independently checks strict output shape, duplicates, field registry, target
kind, per-field options, source evidence, text length, email syntax, number/date
bounds and step. Known uncertain evidence is rejected. Invalid output is never
silently repaired. The required-field queue is computed from validated proposals,
even when the model forgets missing information. An update cannot also request
clarification for its own field.

The scanner exposes only `patternPresent`, not the raw native HTML pattern.
That constraint and custom validity are enforced by Step 6's detached native
control checks during explicit review. Source quotation is a conservative
anti-invention check, not proof that the model interpreted intent correctly.
Choice synonyms and non-ISO dates may need clarification or manual correction.
Semantic field mapping and checkbox intent still require human review.

## Errors and privacy

Normalized errors include `model-unavailable`, `interpretation-timeout`,
`interpretation-busy`, `invalid-model-output`, `unknown-field-id`,
`invalid-option-id`, `target-type-mismatch`, `duplicate-field-update`,
`unsupported-evidence`, `proposal-validation-failed`, and `invalid_request`.
Expired/revoked sessions and stale scans fail closed. Disconnect, cancellation
and stale scans abort the worker request; client disconnect cancels backend work
and releases its inference lock. The session is checked again after inference.

Prompts, transcripts, values, model outputs, credentials and full page content
are not logged. Only elapsed milliseconds, output byte count and a fixed failure
category are recorded. Request data lives in temporary request/UI memory;
there is no transcript/proposal storage or database. Ollama receives only this
request's transcript, approved facts and eligible field metadata; scan context,
page origins/titles/DOM, hidden/sensitive fields and live answers are excluded.
An operator-controlled local Ollama installation must itself remain configured
for local operation.

## Verification and measured model behavior

```bash
npm test
npm run test:python
npm run typecheck
npm run lint
npm run build
npm run test:browser
npm run benchmark:interpretation
```

The fixture file contains 40 model-evaluation cases and 10 deterministic fault
cases. Python tests validate the synthetic golden outputs and independently exercise
malformed JSON, unknown/cross-field IDs, invalid options, checkbox types, duplicate
updates, unsupported evidence, constraints, auth/body limits, missing models,
timeouts, redirects, concurrency, cancellation and revoked sessions. This mocked
suite verifies application behavior, not actual model accuracy.

The benchmark invokes real configured Ollama across the same 40 cases and emits
only case IDs, elapsed time, fixed failure categories and aggregate accuracy.
It exits nonzero below 95% exact-case accuracy. This is intentionally stricter
than proposal precision: safe omissions and extra clarification questions count
as case mismatches. Inspect its actual result before claiming the target is met.
Synthetic fixture content is checked in; transcripts and raw outputs are not
written by the benchmark. See `tests/fixtures/interpretation-benchmark-results.json`
for this implementation's measured run and limitations. On the installed Ollama
0.40.13 / `qwen3.5:2b` model, the final run scored **36/40 exact cases (90%)**,
mean **1.714 s**, maximum **3.801 s**, total **68.543 s**. The 95% target is
**not met**. Four cases differed: two injection-only inputs produced safe extra
clarifications, one negative checkbox answer was omitted, and a certain ISO date
received an unnecessary clarification. These are real model quality limitations;
mocked validation tests do not establish model accuracy. The examples informed
prompt development, so this is a development suite, not an unseen generalization
evaluation. Retain human review and collect a held-out suite before declaring
readiness for complex forms.

Browser tests use isolated Chromium, the production manifest, the real toolbar
activeTab grant, the actual authenticated companion, and a deterministic local
mock Ollama for fault cases. They assert editable proposals remain unselected,
no webpage changes/events/submits, no panel HTTP/storage bypass, retry text
preservation, cancellation, stale-result rejection and no new personal storage.
Permission tests exercise unauthorized batches separately. To include a real
local Qwen request through the browser UI:

```bash
PIKO_TEST_REAL_QWEN=1 npm run test:browser -- tests/interpretation.browser.spec.cjs
```

On PowerShell set `$env:PIKO_TEST_REAL_QWEN="1"` before the test command. Tests
refuse to replace an existing listener on the companion test port 8765.
Implementation verification: Python ran 61 tests (60 passed, one optional
real-Whisper test skipped); the extension unit/contract suite, type checks, lint,
and production build passed. All 26 browser regression workflows passed, and
the additional real-Qwen transport/UI smoke test passed. The five optional real
voice browser tests were not run. Model omissions are measured by the benchmark
above; the transport smoke test verifies a nonempty supported result and does
not assert perfect extraction accuracy.

The existing opt-in real Whisper/microphone tests remain separate. This step
adds no Piper, speech playback, persistent profiles or automatic filling.

References: [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
[chat API](https://docs.ollama.com/api/chat),
[Qwen 3.5 2B model](https://ollama.com/library/qwen3.5:2b).
