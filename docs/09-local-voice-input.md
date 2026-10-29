# Step 8 — Local Whisper voice input

The extension records a short utterance after **Start voice recording**. Stop
ends every microphone track immediately. Completed audio travels through a
trusted worker port to authenticated `POST /v1/transcribe` at
`http://127.0.0.1:8765`. FFprobe inspects it, FFmpeg produces mono 16 kHz signed
16-bit PCM WAV, and the local Whisper.cpp CLI returns English text. Review and
edit the transcript, then explicitly accept, discard, or record again.

**Accept transcript** adds text only to conversation messages. It cannot set
proposals, approve values, invoke the filling engine, submit a form, or call
Ollama/Piper. Existing manual filling remains a separate approval flow.

## Install and configure

Reuse an existing installation first. Obtain Whisper.cpp and `base.en` only
from the [official project](https://github.com/ggml-org/whisper.cpp), following
its [build instructions](https://github.com/ggml-org/whisper.cpp#quick-start)
or its [release packages](https://github.com/ggml-org/whisper.cpp/releases).
Use the model downloader linked in that repository. Obtain FFmpeg and FFprobe
from a provider linked on the [official FFmpeg download page](https://ffmpeg.org/download.html).
Install these tools yourself; the running application never downloads them.

This workspace was verified with the official **Whisper.cpp v1.9.2 CPU x64**
release, `ggml-base.en.bin`, and **FFmpeg/FFprobe 9.0.2 Gyan essentials**. Source
and the official JFK test sample are under ignored `vendor/whisper.cpp`;
the CPU executable is at `vendor/whisper-runtime/bin/Release/whisper-cli.exe`.
FFmpeg and FFprobe are at
`vendor/ffmpeg/bin/ffmpeg-9.0.2-essentials_build/bin/`.
The newer source checkout is not the executable used for validation.

Downloaded Whisper release archive SHA-256:
`49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`.
Model SHA-256:
`a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`.
These record the tested artifacts; review upstream licensing before distributing
any runtime or model. Binaries, model weights, and test audio are not committed.

From the root in PowerShell, verify the installed engine before connecting it:

```powershell
& .\vendor\whisper-runtime\bin\Release\whisper-cli.exe -h
& .\vendor\whisper-runtime\bin\Release\whisper-cli.exe `
  -m .\vendor\whisper.cpp\models\ggml-base.en.bin `
  -f .\vendor\whisper.cpp\samples\jfk.wav -l en -ng -t 4 -nf -sns -np -nt
```

Use the paths for your installation if different. Check for the JFK speech,
including “country,” in the output. The installed CLI must support `-otxt`,
`-of`, `-ng`, `-nf`, `-sns`, `-np`, and `-nt`.

Install service dependencies in its own environment:

```powershell
.\apps\local-service\.venv\Scripts\python.exe -m pip install -r apps/local-service/requirements-dev.txt
```

`requirements.txt` pins direct runtime dependencies; `requirements-dev.txt`
adds HTTP test support. `requirements-lock.txt` records the resolved versions
from this dedicated environment, including test dependencies. To reproduce
that environment exactly, install the lock file instead. Regenerate it with
this environment's `python -m pip freeze` after intentional dependency changes.

Copy `apps/local-service/voice-config.example.json` to
`apps/local-service/.voice-config.json`, and replace the four paths with absolute
paths to existing files. The local file is excluded from Git. Corresponding
environment variables override its settings. English is the only language in
this MVP. Limits may be lowered, but cannot exceed 45 seconds for Whisper,
8 MiB for input, or 20 seconds of decoded audio. Missing or invalid configuration
disables voice capability with a fixed diagnostic that omits private paths.

Start the service in its own terminal:

```powershell
cd apps/local-service
.\.venv\Scripts\python.exe -m app
```

Build with `npm run build`, reload the unpacked extension, and pair using the
startup code as described in the [connection guide](08-local-service-connection.md).
Capabilities should show **Transcription: ready**. In **Load demo form → Start
conversation**, press **Start voice recording**, grant microphone permission,
speak, and press **Stop recording**. The microphone also stops automatically
at 20 seconds. An unconfigured or unpaired companion leaves the button disabled;
typed answers remain available. No additional extension permission or unauthenticated
Whisper server is used.

## Transport and media boundary

- Only the exact side-panel sender may open `PIKO_VOICE_V1`; content scripts,
  other pages, and a second simultaneous transfer are rejected. Each recording
  uses an opaque ID, exact byte/chunk counts, sequential 48 KiB Base64 chunks,
  per-chunk acknowledgement, and one final commit. Assembly expires after 15
  seconds. Blobs are constructed inside each context, never assumed to survive
  Chrome's JSON runtime messages.
- The worker owns HTTP, bearer credentials, the fixed destination, multipart
  construction, and strict response validation. The panel never fetches local
  services. Audio and transcripts are never placed in extension storage.
- Authentication and exact paired origin are checked before media parsing, and
  again before returning inference results. Request bodies are bounded during
  reception (8 MiB plus 16 KiB multipart overhead), with a 15-second upload
  deadline. One file named `file` is allowed, with no additional form fields.
  Its supplied filename and MIME type cannot choose files, executables, or models.
- Magic bytes and FFprobe must agree on a supported WAV, WebM, Ogg, or MP4 audio
  container, with one supported audio stream. FFprobe has a 5-second deadline;
  FFmpeg has 10 seconds and bounded output. Duration over 20 seconds is rejected,
  never silently truncated. MediaRecorder WebM may omit duration, so decoded WAV
  frame counts independently enforce the limit. Small encoder overrun is also
  rejected. Extremely short recordings (under 250 ms) are discarded.
- Fixed argument arrays use no shell, no input/stdout/stderr logging, and no
  remote media protocols. Whisper uses CPU, four threads, English, `-nf -sns`,
  and text-file output. One transcription job runs at a time. Low-energy silence
  skips Whisper, and empty/non-speech output returns `no-speech`; this reduces
  hallucinations without guaranteeing recognition accuracy.
- Random per-request temporary directories hold only the upload, WAV, and CLI
  transcript. Cleanup runs on success, failure, timeout, and cancellation; the
  child process is killed and reaped first. Browser audio stays in memory and
  is released on discard, completion, failure, unmount, or port disconnect.
  Temporary disk files can remain after an OS/process crash; this is not secure
  erasure or a crash-recovery guarantee. Use an appropriate OS temp location.

Whisper's configured server timeout is at most 45 seconds. Chrome MV3 can end
a worker fetch if response headers take 30 seconds; this client cancels at
28 seconds (29 seconds on the port), then the server cancels the subprocess and
cleans up. On slower machines use shorter utterances. There is no partial
transcription fallback or cloud request.

## API

The authenticated multipart response has exact fields:

```json
{"status":"ok","text":"Synthetic example.","language":"en","durationMs":1000,"processingMs":500}
```

Times are illustrative. No speech returns the same shape with `status:
"no-speech"` and empty `text`. Stable errors use `{"error":"code"}`:
`empty-audio`, `unsupported-audio`, `invalid-audio`, `audio-too-large`,
`audio-too-long`, `conversion-failed`, `model-unavailable`,
`transcription-busy`, `transcription-timeout`, `transcription-failed`, and
`request-cancelled`. Existing authentication errors retain the Step 7 contract.
No raw exception, subprocess output, local configuration, or audio is returned.

## Verification

From the root:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
$env:PIKO_TEST_REAL_VOICE='1'
.\apps\local-service\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
$env:PIKO_CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
npx playwright test tests/connection.browser.spec.cjs tests/voice.browser.spec.cjs
```

Without `PIKO_TEST_REAL_VOICE=1`, the real-engine Python and voice browser tests
skip; fixture-based tests still run. The opt-in browser tests use installed
Chrome, the official sample WAV as a fake microphone, actual MediaRecorder,
worker messaging, pairing, real HTTP, FFmpeg, and Whisper. They also verify
track shutdown, discard, permission rejection, edited acceptance, temporary-file
cleanup, empty persistent storage, worker-only loopback requests, no proposal
updates, and an untouched/unsubmitted target form. Never aim automated tests at
a physical microphone. `PIKO_VOICE_SAMPLE` can override the browser sample path.

Remaining manual checks: grant/deny a real Chrome permission prompt; record on
the physical microphone; inspect its browser/OS recording indicator; test device
unplug and OS permission revocation; assess accents, background noise, and latency
on the intended machine. Fake-device automation cannot establish those results.

Audio and recognized text must stay out of logs and committed fixtures. The
existing product acceptance documents include future interpretation/playback
goals; those are not Step 8 completion claims.

Verified on Windows on 2026-10-30: the direct installed Whisper CLI test,
68 JavaScript tests plus the contract harness, 42 Python tests including real
FFmpeg/Whisper, TypeScript, lint, production build, 10 Chrome browser tests
(five connection and five voice), and 18 existing Edge browser regressions
passed. The voice tests include the full 20-second timer and cancellation
after upload. Test-owned companion processes were stopped afterward.
