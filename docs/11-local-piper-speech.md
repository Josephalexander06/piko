# Step 10 — Local Piper speech output

Piko 0.3.0 adds opt-in spoken questions and status messages through the existing
paired FastAPI service. Text remains visible and editable. Scanning, proposals,
review, overwrite permission and filling keep their existing authority checks.
Speech cannot approve a proposal or submit a form.

## Setup

Use the existing local-service virtual environment. No model is downloaded at
startup; the setup download below is an explicit installation step.

Linux/macOS, from the repository root:

```bash
apps/local-service/.venv/bin/python -m pip install -r apps/local-service/requirements-dev.txt
export ORT_DISABLE_TELEMETRY=1
apps/local-service/.venv/bin/python -m piper.download_voices en_US-lessac-medium --data-dir apps/local-service/voices
export PIPER_VOICE_PATH=voices/en_US-lessac-medium.onnx
export PIPER_MAX_TEXT_CHARS=800
export PIPER_MAX_CONCURRENCY=1
export PIPER_TIMEOUT_SECONDS=30
cd apps/local-service
.venv/bin/python -m app
```

PowerShell, from the repository root:

```powershell
.\apps\local-service\.venv\Scripts\python.exe -m pip install -r apps/local-service/requirements-dev.txt
$env:ORT_DISABLE_TELEMETRY = "1"
.\apps\local-service\.venv\Scripts\python.exe -m piper.download_voices en_US-lessac-medium --data-dir apps/local-service/voices
$env:PIPER_VOICE_PATH = "voices/en_US-lessac-medium.onnx"
$env:PIPER_MAX_TEXT_CHARS = "800"
$env:PIPER_MAX_CONCURRENCY = "1"
$env:PIPER_TIMEOUT_SECONDS = "30"
cd apps/local-service
.\.venv\Scripts\python.exe -m app
```

The voice path resolves against `apps/local-service`, independently of the
launching directory. Both `en_US-lessac-medium.onnx` and
`en_US-lessac-medium.onnx.json` must exist. English ESpeak voices are supported
in this MVP; other phonemizers are rejected because they can fetch additional
resources. Configuration is server-owned; requests cannot select a voice,
filesystem path, program, model, URL, or synthesis arguments. `.env.example`
documents settings and is not loaded automatically.

For a separate CLI check (not the application's runtime transport), pipe one
short synthetic message into Piper. From the repository root:

```bash
printf '%s\n' 'Hello. What is your full name?' | ORT_DISABLE_TELEMETRY=1 apps/local-service/.venv/bin/python -m piper -m apps/local-service/voices/en_US-lessac-medium.onnx -f /tmp/piko-voice-test.wav
```

PowerShell:

```powershell
$env:ORT_DISABLE_TELEMETRY = "1"
"Hello. What is your full name?" | .\apps\local-service\.venv\Scripts\python.exe -m piper -m apps/local-service/voices/en_US-lessac-medium.onnx -f "$env:TEMP\piko-voice-test.wav"
```

Play the resulting WAV to check the actual speaker output and voice quality.
The application itself never writes generated audio files.

Build with `npm run build`, reload `apps/extension/dist` in `chrome://extensions`,
restart and pair the companion, and check **Speech synthesis: ready**. Speech
starts disabled. Click **Enable spoken responses and test voice** to play the
visible assistant message. **Play aloud**, **Stop speech**, and **Disable spoken
responses** are explicit controls. If autoplay is blocked, press **Play aloud**
to synchronously retry the one prepared clip. Text stays available on all errors.

## Lifecycle and hard bounds

The FastAPI lifespan starts one persistent Python worker and waits for its ready
handshake. That worker loads `PiperVoice` once and reuses `synthesize_wav()` for
all phrases. It has no HTTP listener; FastAPI remains the sole authenticated HTTP
entry point. CPU-heavy ONNX synthesis runs outside the API event loop. This is
not a new Piper CLI launch per phrase. A process boundary allows hung native
inference to be terminated; merely cancelling a Python thread would not stop it.

Only one bounded synthesis job runs at a time. Additional requests return
`speech-busy`, with no unbounded queue. A disconnected caller stops receiving
output; its already running job drains and discards audio while retaining the
single-job limit and deadline. This permits normal playback cancellation without
reloading the voice. On a timeout or worker failure, the worker is terminated,
capabilities become unavailable, and a service restart is needed to load it again.
Shutdown cancels pending work, terminates the worker and releases ONNX resources.
Piper exposes no explicit voice close API; process exit releases its session.

Limits:

| Boundary | Limit |
| --- | --- |
| HTTP request body | 8 KiB, authenticated before receiving/parsing |
| Plain text | 800 characters, configurable downward |
| Synthesis concurrency | One; other settings are rejected |
| Native synthesis/startup deadline | 30 seconds, configurable downward |
| Worker HTTP watchdog | 28 seconds, then request abort and text fallback |
| WAV payload | 8 MiB |
| Audio format | RIFF PCM, mono, 16-bit, 8–48 kHz, at most 120 seconds |
| Extension chunk | 48 KiB, canonical base64, acknowledged in order |
| Per-chunk acknowledgment | Three seconds |
| Playback/blocked-replay lease | At most 125 seconds |

Empty/whitespace, oversized text, extra request keys, duplicate JSON keys,
HTML/SSML delimiters, bracket/brace directives, control characters, private-use
characters and invalid Unicode are rejected. Compatibility normalization is used
only to detect disguised markup; accepted text is not silently rewritten.
Raw page HTML, original answers, proposed personal values and Qwen's raw
clarification wording are not automatically sent to Piper.

The native in-memory WAV writer enforces its cap while writing. The API manager
and extension independently validate WAV headers, format, frame data and size.
No partial, reordered, oversized or malformed transfer is played. The response
uses `Content-Type: audio/wav`, `Cache-Control: no-store`, and `nosniff`.
Authentication is rechecked after generation so a revoked/expired session cannot
receive a completed clip. Errors contain fixed codes, never text, paths, native
output, tokens or audio.

## Privacy and voice coordination

The extension worker performs every HTTP request. A trusted side-panel port uses
message IDs, an explicit byte/chunk count, ordered ACKs, canonical base64 chunks,
and a final complete message. The worker drops its audio buffer after transfer;
the port retains a bounded playback lease. Blobs are created only in the panel.
No binary Blob is assumed to survive Chrome messaging.

`VoiceCoordinator` owns the recording/playback transition. It stops microphone
tracks (or invalidates a pending capture) before starting speech, and stops
playback before beginning a new recording. **Start voice recording** is disabled
while speech is preparing/playing; **Stop speech and record** explicitly performs
the transition. No automatic recording starts when speech ends. No audio playback
is uploaded as a transcription, and utterances cannot overlap in the controller.

Object URLs, audio elements, timers, transfers and buffers are released after
playback, failure, cancellation, reset, stale scan, disconnect, page hide and
panel teardown. Autoplay rejection retains only one validated bounded clip for
manual replay until it is played, cancelled or its lease expires; its failed
object URL is already revoked. Personal transcripts, speech text and WAV data
are never stored in extension storage, service files, logs or a database. The
only session storage remains the existing pairing credential.

Automatic speech uses fixed application templates for known field meanings, or
an application-generated generic clarification. Qwen's original question remains
visible in the interpretation feedback. The exact application message being
spoken is also visible in **Assistant message to speak**, where it can be edited
and replayed explicitly. Arbitrary page labels, source evidence, names, email
addresses, phone numbers and proposed values are never interpolated into an
automatic utterance. This preserves a readable fallback without reading private
answers aloud by default.

ONNX Runtime's official builds enable telemetry by default. The service forces
`ORT_DISABLE_TELEMETRY=1` in the worker environment **before Python starts**, the
worker sets it before native imports, and it also calls
`disable_telemetry_events()`. The process-level opt-out is necessary to suppress
initialization events and device identifiers, which an API call alone cannot
prevent. Set the environment variable before the manual Piper downloader/CLI
commands as shown above. See the [ONNX privacy documentation](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md).

## Capabilities and failures

`GET /v1/capabilities` now reports `speech_synthesis: ready | unavailable` from the
actual loaded worker. `speech_synthesis_detail` is null when ready, otherwise a
fixed non-sensitive reason: `speech-voice-missing`, `speech-voice-invalid`,
`speech-configuration-invalid` or `speech-unavailable`. Model readiness is
independent of Whisper and Qwen. Optional Piper failure does not change the
health endpoint's overall `status: ok`. New extension code also accepts older
capability payloads without the detail field.

The authenticated `POST /v1/synthesize` accepts only `{"text":"…"}`. Errors include
`speech-busy`, `speech-timeout`, `speech-audio-too-large`, `invalid-speech-text`,
`invalid-speech-audio`, `speech-synthesis-failed` and availability reasons.
Invalid JSON/request shapes receive the existing normalized `invalid_request`.
Playback/transfer errors are sanitized client-side with a visible text fallback.

## Qwen 2.5 14B

Piper does not use a language model to speak. The installed `qwen2.5:14b` was used
for one real interpretation in the Step 10 browser integration test. To choose
it for the existing interpretation service, set this before starting it:

```bash
export OLLAMA_MODEL=qwen2.5:14b
```

PowerShell: `$env:OLLAMA_MODEL = "qwen2.5:14b"`.
No model is downloaded or switched automatically. The default stays
`qwen3.5:2b`; one 14B integration check does not establish accuracy or latency
across the Step 9 benchmark. The recorded 90% Step 9 result remains unchanged.

## Voice licensing and setup provenance

The maintained [Piper package](https://pypi.org/project/piper-tts/) is
GPL-3.0-or-later; see its [COPYING](https://github.com/OHF-Voice/piper1-gpl/blob/main/COPYING).
The exact [Lessac medium model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD)
references the [Blizzard 2013 Lessac data license](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html),
which describes research-only/noncommercial dataset use. This is not a blanket
commercial distribution grant for the voice. Review engine and exact voice/data
terms before redistribution; no voice asset is included in this commit or ZIP.
The project's license has not been changed or inferred from the model download.

This setup used `piper-tts==1.8.0`, `onnxruntime==1.31.1`, Python 3.14.7 and the
English Lessac medium voice at 22,050 Hz. Local asset SHA-256 values:

- ONNX: `5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f`
- JSON: `efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0`

The existing dependency files were extended, not replaced by a machine dump.
Voice assets remain ignored under `voices/`. The lock records the tested Python
3.14 dependency closure; other supported Python environments can resolve their
compatible wheels from `requirements-dev.txt`.

## Verification

```bash
npm run build
npm test
npm run typecheck
npm run lint
npm run test:python
npm run test:browser
```

Opt in to installed-voice checks:

```bash
ORT_DISABLE_TELEMETRY=1 PIKO_TEST_REAL_PIPER=1 npm run test:python
PIKO_TEST_REAL_PIPER=1 npm run test:browser -- tests/speech.browser.spec.cjs
```

On Windows set the environment variables with `$env:NAME="value"`, then use the
venv Python explicitly in place of `npm run test:python` if needed.
The normal Python suite uses fake voices/processes for deterministic faults;
real tests additionally load the installed voice. Tests cover strict text,
invalid/missing assets, WAV validity, native output caps, one-time load/reuse,
authentication, safe errors, concurrency, cancellation/draining, process timeout,
revocation, ordered binary transfer, autoplay rejection, URL cleanup, visible
text, microphone exclusion and lack of persistent personal storage.

Real local API measurements: one worker loaded in about 1.38 seconds; two
successive synthetic phrases took about 62 ms and 49 ms, returning 86,060 and
81,452 WAV bytes using the same worker PID. These are local smoke measurements,
not a hardware-independent performance guarantee. A separate synthesis succeeded
inside the network-restricted sandbox after setup, producing a valid 22,050 Hz
WAV without external networking. The CLI smoke check also generated a valid WAV.

The end-to-end browser test uses real Piper, real Qwen 2.5 14B, real Chromium
MediaRecorder with a synthetic microphone, the production manifest, the real
activeTab action grant, and real paired HTTP transport. Its Whisper endpoint is
explicitly a **transcription fixture**; it does not claim to verify real Whisper
recognition. It confirms edited transcription acceptance, explicit interpretation,
a safe spoken review status, unselected proposals and an unchanged webpage.

Actual checks executed for this step: Python ran 76 tests (75 passed and one
optional real-Whisper check skipped). The complete browser run passed 31 tests;
six unrelated opt-in checks were skipped (the five real-Whisper browser cases
and the separate Step 9 real-Qwen benchmark smoke case). The normal contract/
extension unit suite, type checks, lint and production build passed. The Piper
browser cases include the real-voice/Qwen-14B loop described above.

Manual verification still required: physical speaker quality/volume and
microphone echo on the target machine, actual Whisper configuration/recognition,
and any target-browser local-network/autoplay prompts. The existing opt-in real
Whisper suite was not run because its executables/model are not configured here.
No profiles, automatic submission or Step 11 conversation engine were added.

References: [Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md),
[voice setup and licensing](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md).
