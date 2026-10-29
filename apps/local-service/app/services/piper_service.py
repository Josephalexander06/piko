"""One lifespan-owned Piper Python worker, no second HTTP server or per-phrase CLI.
Native inference runs outside the event loop. A persistent worker lets us kill a
hung native call at the deadline; timed-out workers stay unavailable until restart.
"""
import asyncio
import io
import os
from dataclasses import dataclass
from pathlib import Path
import struct
import sys
import wave
from ..schemas.synthesize import MAX_TEXT_CHARS, MAX_WAV_BYTES, MAX_WAV_SECONDS, plain_text

SERVICE_DIR = Path(__file__).resolve().parents[2]


class SpeechError(Exception):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


@dataclass(frozen=True)
class PiperConfig:
    voice_path: Path = SERVICE_DIR / 'voices/en_US-lessac-medium.onnx'
    max_chars: int = MAX_TEXT_CHARS
    concurrency: int = 1
    timeout: float = 30
    max_bytes: int = MAX_WAV_BYTES
    configured: bool = True

    @classmethod
    def load(cls, env=None):
        env = os.environ if env is None else env
        try:
            voice = Path(env.get('PIPER_VOICE_PATH', str(cls.voice_path))).expanduser()
            if not voice.is_absolute():
                voice = SERVICE_DIR / voice
            maximum = int(env.get('PIPER_MAX_TEXT_CHARS', str(MAX_TEXT_CHARS)))
            concurrency = int(env.get('PIPER_MAX_CONCURRENCY', '1'))
            timeout = float(env.get('PIPER_TIMEOUT_SECONDS', '30'))
            if not (1 <= maximum <= MAX_TEXT_CHARS and concurrency == 1 and 1 <= timeout <= 30):
                raise ValueError()
            return cls(voice.resolve(), maximum, concurrency, timeout)
        except (ValueError, OSError, TypeError):
            return cls(configured=False)


def validate_wav(data: bytes, maximum=MAX_WAV_BYTES) -> None:
    if not 44 < len(data) <= maximum or data[:4] != b'RIFF' or data[8:12] != b'WAVE' or struct.unpack('<I', data[4:8])[0] + 8 != len(data):
        raise SpeechError('invalid-speech-audio', 502)
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            channels, width, rate, frames = audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()
            if (channels != 1 or width != 2 or not 8000 <= rate <= 48000 or not 0 < frames <= rate * MAX_WAV_SECONDS
                    or audio.getcomptype() != 'NONE' or len(audio.readframes(frames)) != frames * width * channels):
                raise ValueError()
    except (ValueError, EOFError, wave.Error):
        raise SpeechError('invalid-speech-audio', 502) from None


class PiperService:
    def __init__(self, config: PiperConfig | None = None):
        self.config = config or PiperConfig.load()
        self.process: asyncio.subprocess.Process | None = None
        self.job: asyncio.Task | None = None
        self.reason = 'speech-unavailable'
        self.started = False
        self.closed = False

    @property
    def ready(self):
        return self.reason is None and self.process is not None and self.process.returncode is None and not self.closed

    async def _read(self) -> bytes:
        header = await self.process.stdout.readexactly(4)
        length = struct.unpack('>I', header)[0]
        if not 1 <= length <= self.config.max_bytes + 1:
            raise SpeechError('speech-audio-too-large', 502)
        return await self.process.stdout.readexactly(length)

    async def start(self):
        if self.started:
            return
        self.started = True
        if not self.config.configured:
            self.reason = 'speech-configuration-invalid'
            return
        model = self.config.voice_path
        try:
            if not model.is_file() or not Path(str(model) + '.json').is_file():
                self.reason = 'speech-voice-missing'
                return
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, '-m', 'app.services.piper_worker', str(model), str(self.config.max_bytes),
                cwd=SERVICE_DIR, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=65536,
                env={**os.environ, 'ORT_DISABLE_TELEMETRY': '1'},
            )
            async with asyncio.timeout(self.config.timeout):
                if await self._read() != b'R':
                    raise SpeechError('speech-voice-invalid', 503)
            self.reason = None
        except asyncio.CancelledError:
            self.reason = 'speech-unavailable'
            await self._terminate()
            raise
        except (OSError, TimeoutError, asyncio.IncompleteReadError, SpeechError):
            self.reason = 'speech-voice-invalid'
            await self._terminate()

    async def _terminate(self):
        process = self.process
        self.process = None
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        if process.returncode is None:
            try:
                process.terminate()
                await asyncio.wait_for(process.wait(), 1)
            except (ProcessLookupError, TimeoutError):
                if process.returncode is None:
                    try: process.kill()
                    except ProcessLookupError: pass
                    await process.wait()

    async def close(self):
        self.closed = True
        if self.job and not self.job.done():
            self.job.cancel()
            await asyncio.gather(self.job, return_exceptions=True)
        await self._terminate()
        self.reason = 'speech-unavailable'

    async def _generate(self, text: str) -> bytes:
        try:
            async with asyncio.timeout(self.config.timeout):
                data = text.encode('utf-8')
                self.process.stdin.write(struct.pack('>I', len(data)) + data)
                await self.process.stdin.drain()
                response = await self._read()
                if response[:1] != b'O':
                    code = response[1:].decode('ascii', errors='replace')
                    raise SpeechError(code if code in ('speech-audio-too-large', 'speech-synthesis-failed') else 'speech-synthesis-failed', 502)
                audio = response[1:]
                validate_wav(audio, self.config.max_bytes)
                return audio
        except TimeoutError:
            self.reason = 'speech-unavailable'
            await self._terminate()
            raise SpeechError('speech-timeout', 504) from None
        except (OSError, asyncio.IncompleteReadError):
            self.reason = 'speech-unavailable'
            await self._terminate()
            raise SpeechError('speech-synthesis-failed', 502) from None
        except SpeechError:
            self.reason = 'speech-unavailable'
            await self._terminate()
            raise

    def _finished(self, task):
        # Consume safe exceptions when the HTTP caller disconnected. Do not retain
        # synthesized audio or the original text after this bounded operation.
        if not task.cancelled():
            task.exception()
        if self.job is task:
            self.job = None

    async def synthesize(self, text: str) -> bytes:
        try:
            plain_text(text, self.config.max_chars)
        except ValueError:
            raise SpeechError('invalid-speech-text') from None
        if not self.ready:
            raise SpeechError(self.reason or 'speech-unavailable', 503)
        if self.job is not None:
            raise SpeechError('speech-busy', 429)
        self.job = asyncio.create_task(self._generate(text))
        self.job.add_done_callback(self._finished)
        # A disconnect stops delivery, while this single bounded job drains and
        # discards its response. This preserves the loaded voice without overlap.
        return await asyncio.shield(self.job)
