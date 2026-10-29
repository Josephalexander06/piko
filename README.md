
# Piko — Step 7 authenticated local companion

A local-first Chrome extension with an explicitly activated form scanner,
manual proposal review, one-use approval, verified form filling, and a separate
synthetic conversation/review demo. The independent
Python companion service supports health checks, temporary pairing, and authenticated
capability and connectivity checks at `http://127.0.0.1:8765`. Inference,
transcription, and speech synthesis explicitly report `not_integrated`.
No form answers, page metadata, transcripts, or audio are sent to the service.

## Repository layout

```text
apps/extension/       React + TypeScript + CRXJS/Vite + shadcn/ui, Manifest V3
apps/local-service/   FastAPI + Pydantic + Uvicorn; separate Python environment
contracts/           Shared schemas, including the Step 6 runtime approval grant
docs/                Product specification, threat model, acceptance tests, setup
test/                Preserved Step 2 contract harness and synthetic fixtures
tests/               Contract, reducer, extension-browser, and service checks
scripts/             Live service verification utility
```

## Quick start

Use Node.js 22.12+ (or 20.19+) and Python 3.10+. Commands below assume the
repository root unless a `cd` is shown. Python 3.14 was used during setup.

```bash
npm ci
npm --prefix apps/extension ci
npm run build
npm run dev:extension
```

In Chrome 116+, open `chrome://extensions`, enable **Developer mode**, select
**Load unpacked**, and choose `apps/extension/dist` inside this repository.
The generated manifest is `apps/extension/dist/manifest.json`. Keep Vite running
for development, pin the extension, and click its toolbar icon to open the side
panel. A production build uses the same directory and needs no Vite server.
Rebuild before switching between development and production.

In the side panel, choose **Load demo form → Start conversation → Use sample
answer → Review proposed values**. Edit or exclude answers, then choose
**Simulate approval**. The required organization starts missing; provide a
fictional answer or leave it excluded for manual completion. **Reset session**
clears all messages, proposals, typed drafts, and simulated approvals.

For the live read-only scanner, open an HTTP/HTTPS page, click Piko’s toolbar
icon on that tab, then choose **Inspect this page** in the side panel. It returns
field metadata without collecting existing answers or modifying the page.
Try the synthetic local fixture first; see the [scanner guide](docs/06-form-scanner.md).

After inspection, use **Prepare manual answers** to include fields and enter
synthetic values. Choose **Review selected values**, resolve validation and
overwrite conflicts, then explicitly approve the exact batch. The extension
fills only that batch and reports per-field outcomes. See the
[Step 6 filling guide](docs/07-permission-gated-filling.md) for setup, guarantees,
limitations, and the test commands.

The scanner and UI demo run without the Python service. See the
[Step 4 UI guide](docs/05-extension-ui.md) for state transitions and verification.

To run the companion API, start a second terminal (Linux/macOS):

```bash
cd apps/local-service
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m app
```

Windows PowerShell:

```powershell
cd apps/local-service
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m app
```

No environment activation is needed. `python -m app` binds to **127.0.0.1:8765**
with reload, access logging, and proxy-header interpretation disabled. Install `requirements.txt`
instead if service tests are not needed. The explicit dependencies avoid the
telemetry and cloud CLI packages pulled in by current `fastapi[standard]`.

In the side panel, expand **Local service connection**, choose **Check service**,
and enter the 16-character code printed in that terminal. Choose **Pair extension**.
Codes expire after five minutes and work once. Sessions last at most 12 hours.
**Disconnect service** revokes the token; restart the service for another code.
See the [Step 7 connection guide](docs/08-local-service-connection.md) for the API,
permissions, restart behavior, limitations, and actual Chrome tests.

From the repository root, verify the running API:

```bash
python3 scripts/verify-service.py
```

On Windows, use `py scripts/verify-service.py`. The expected response is:

```json
{
  "status": "ok",
  "service": "local-voice-form-assistant",
  "version": "0.1.0",
  "inference": "not_integrated",
  "protocol_version": 1
}
```

## Verification

```bash
npm run build
npm run typecheck
npm run lint
npm test
apps/local-service/.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

For Windows, replace the final Python executable with
`.\apps\local-service\.venv\Scripts\python.exe`. Optional Chromium smoke test:

```bash
npx playwright install chromium
npm run test:browser
```

See [the setup and verification guide](docs/04-development-setup.md) for listener
checks, exact build outputs, browser verification, dependency boundaries, and
troubleshooting. See [the product specification](docs/01-product-spec.md),
[threat model](docs/02-privacy-threat-model.md), and
[acceptance tests](docs/03-acceptance-tests.md) for later-phase requirements.

The production extension requests `sidePanel`, `activeTab`, `scripting`, and
`storage`, plus the loopback service host. Its fixed worker-only HTTP client and
CSP restrict service requests to `127.0.0.1:8765`. Session credentials use
`chrome.storage.session`; they never go to the panel, content scripts, or
persistent storage. The scanner still requires an explicit toolbar activation
on ordinary websites. The API enforces extension-origin validation and bearer
authentication independently of CORS. Model and documentation routes are absent.

The original plan below and the frozen Step 2 documents describe the future MVP.
Their `/health` and `/api/v1/*` routes and model-install instructions do not
describe the current implementation. `/v1/health` remains the implemented endpoint.

---

# Original PIKO Implementation Plan (preserved)

## 1. Goal and Design Decision

Build a local voice assistant that identifies web-form fields, reuses approved information, asks for missing answers, and automatically fills the form within user-granted permissions.

Compare these two approaches:

| Aspect | Sequential voice workflow | Privacy-first preview workflow |
|---|---|---|
| Interaction | Ask, transcribe, fill, confirm each field | Prepare answers privately, then approve filling |
| Strength | Clear conversational guidance | Prevents disclosure before approval |
| Limitation | Repetitive questions; confirmation happens after disclosure | Repeated field selection can undermine automation |
| Recommended combination | Ask only for missing or uncertain details; approve a batch before inserting it | |

**Chosen behavior:** prepare privately → approve destination and fields → fill automatically → ask only when new permission or clarification is needed.

Approval occurs before insertion. Submission remains manual.

## 2. Architecture and Interfaces

Use a Chrome extension connected to a local companion service.

| Component | Technology | Responsibility |
|---|---|---|
| Extension | Manifest V3, TypeScript, React, Vite | Side panel, microphone recording, permissions, review |
| Form adapter | Content script, MutationObserver | Extract fields, insert approved values, observe changes |
| Local service | Python, FastAPI, Pydantic | Coordinate speech, model inference, validation |
| Speech recognition | whisper.cpp | Transcribe recordings locally |
| Language model | Ollama, local Qwen2.5 3B | Interpret answers and propose field mappings |
| Speech synthesis | Piper | Speak questions and progress messages |
| Temporary profile | Extension memory | Reuse explicitly selected details during the active session |

Use English for the initial demo. Additional languages require separate transcription, model, and voice testing.

Do not persist profiles in the prototype. Closing the session clears its reusable information.

**Service interface:**

- `GET /health`: report model and speech-engine readiness.
- `POST /transcribe`: accept a short recording and return text.
- `POST /interpret`: accept allowed field definitions and the current answer; return proposed updates and clarification questions.
- `POST /synthesize`: accept a question and return speech audio.

Requests require a per-installation pairing token. Keep the service bound to loopback and allow only the paired extension origin.

**Field identity:**

The extension assigns opaque IDs to supported fields and maintains their DOM references. AI returns IDs, never executable JavaScript or generated selectors.

```json
{
  "updates": [
    {
      "fieldId": "field_17",
      "value": "Ayham"
    }
  ],
  "clarifications": []
}
```

Reject unknown IDs, unsupported values, and stale form references. Structured output controls shape; application code must still validate meaning.

## 3. Execution and Privacy Rules

1. **Activate:** the user starts Piko on the current page.
2. **Inspect:** extract visible, enabled fields, associated labels, options, instructions, and constraints. Exclude hidden inputs and unrelated page content.
3. **Plan:** match approved session details to fields; identify missing answers. Generate a short form summary.
4. **Converse:** Piper asks about missing information. Record with push-to-talk and transcribe locally. Stop recording during speech playback.
5. **Interpret:** allow one answer to populate several proposed values. Ask targeted questions for ambiguity; never invent information.
6. **Preview:** show the destination origin, proposed values, and their source. Users can edit or deselect values.
7. **Approve and fill:** create an in-memory permission containing the origin, tab, form instance, and exact field-value pairs. Fill that batch without further prompts.
8. **Verify:** use appropriate input/change events and check accepted values and browser validation. Report failures rather than claiming completion.
9. **Observe:** newly revealed fields start unapproved. Collect missing answers and approve them together in another batch.
10. **Finish:** show remaining issues and provide a final review. The user submits through the website.

Additional boundaries:

- A spoken confirmation after filling does not replace approval before filling.
- Changed values require new approval; existing permission cannot authorize different personal data.
- Expire permission after navigation, origin change, form replacement, or session end.
- Exclude passwords, OTPs, payment credentials, and detected identity-number fields. Unsupported or uncertain sensitive fields remain manual.
- Do not support cross-origin frames, CAPTCHA solving, file uploads, or automatic navigation in this version.
- Treat webpage instructions as untrusted data. They cannot override permissions or authorize tool calls.
- Keep audio temporary. Exclude recordings, transcripts, and field values from logs and analytics.
- Disable cloud inference and cloud fallbacks. Bundle application assets locally.
- Explain that approved websites may read inserted values before submission; clearing values cannot reverse disclosure.

## 4. Fourteen-Hour Build Sequence

Assume one developer and an existing computer; the schedule is a prototype target, not a production-release estimate.

| Time | Deliverable |
|---|---|
| Hours 0–1 | Install models; benchmark transcription, extraction, and Piper playback on the demo computer |
| Hours 1–4 | Extension panel, field registry, inspection, permission preview, deterministic filling |
| Hours 4–6 | Local service, recording conversion, Whisper transcription, Piper playback |
| Hours 6–8 | Structured answer extraction, validation, multi-field answers, clarification |
| Hours 8–10 | Session profile reuse and permission enforcement |
| Hours 10–12 | Conditional fields, validation feedback, corrections, failure handling |
| Hours 12–14 | End-to-end checks, user trials, demo recording, setup documentation |

Start with a multilingual Whisper base model and quantized Qwen2.5 3B. If response times are unacceptable, benchmark Whisper tiny; retain text input as a fallback. Do not silently switch to cloud processing.

The hardware benchmark is a release gate: if the available machine cannot run the local pipeline acceptably, report that limitation rather than promise real-time voice.

Expected incremental AI API and hosting spend: **₹0**, assuming existing hardware and local execution. Electricity, downloads, packaging, support, and any hardware purchases are additional costs.

Before distributing binaries, review the selected runtime, model, Piper, and voice licenses.

## 5. Validation and Release Criteria

Use synthetic personal information and two controlled test forms with different labels and layouts. Include text, email, select, radio, checkbox, repeated labels, and one conditional section.

**Required checks:**

- One spoken answer proposes values for multiple correct fields.
- Ambiguous answers produce clarification.
- No personal values enter the webpage before approval.
- Deselecting a field prevents insertion.
- Permission cannot transfer to another origin, tab, or replaced form.
- Hidden, excluded, and unknown fields remain untouched.
- Conditional fields trigger another private preparation-and-approval cycle.
- Invalid values are surfaced and can be corrected.
- Unauthenticated local requests are rejected.
- Voice inference works with external networking blocked after setup.
- Model failure preserves the draft and permits manual completion.

**Initial targets, to be measured rather than advertised as achieved:**

- At least 95% correct field-value proposals over 40 defined test cases.
- Zero unapproved insertions in the permission test suite.
- Median end-of-recording to displayed proposal below five seconds on the documented demo hardware.
- At least four of five trial users finish both supported forms without developer assistance.

Compare completion time, corrections, and prompts against manual completion with browser autofill enabled. Record first-use and repeat-use results separately.

Publish an installable prototype only after documenting its hardware requirements, supported form types, privacy boundaries, measured results, and known failures. Broad website support and accessibility benefits remain claims to validate.

