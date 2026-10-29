"""Private persistent Python-API worker. Framed stdin/stdout only; no listener.
Never print input, phonemes, native diagnostics or audio to an application log.
"""
import io
import json
import logging
import os
from pathlib import Path
import struct
import sys
import wave
from ..schemas.synthesize import MAX_WAV_BYTES, plain_text

# Must precede the first native ONNX import; an API call alone is too late for
# its initialization event/device identifier. The parent also forces this env.
os.environ['ORT_DISABLE_TELEMETRY'] = '1'


class BoundedBuffer(io.BytesIO):
    def __init__(self, maximum):
        super().__init__()
        self.maximum = maximum
    def write(self, data):
        if self.tell() + len(data) > self.maximum:
            raise OverflowError('speech-audio-too-large')
        return super().write(data)


def generate(voice, text, maximum=MAX_WAV_BYTES):
    plain_text(text)
    buffer = BoundedBuffer(maximum)
    try:
        with wave.open(buffer, 'wb') as output:
            voice.synthesize_wav(text, output)
        return buffer.getvalue()
    finally:
        buffer.close()


def main():
    logging.disable(logging.CRITICAL)
    def send(data):
        sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
        sys.stdout.buffer.flush()
    try:
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from piper import PiperVoice
        path = Path(sys.argv[1])
        maximum = int(sys.argv[2])
        if not 44 < maximum <= MAX_WAV_BYTES:
            raise ValueError()
        config_path = Path(str(path) + '.json')
        if config_path.stat().st_size > 262144:
            raise ValueError()
        config = json.loads(config_path.read_text())
        # English espeak only: other phonemizers may fetch extra resources.
        if config.get('phoneme_type', 'espeak') != 'espeak' or not str(config.get('espeak', {}).get('voice', '')).startswith('en'):
            raise ValueError()
        voice = PiperVoice.load(path, config_path=config_path, use_cuda=False)
        send(b'R')
    except Exception:
        send(b'Espeech-voice-invalid')
        return
    try:
        while True:
            header = sys.stdin.buffer.read(4)
            if not header:
                return
            if len(header) != 4:
                return
            length = struct.unpack('>I', header)[0]
            if not 1 <= length <= 3200:
                return
            data = sys.stdin.buffer.read(length)
            if len(data) != length:
                return
            try:
                text = data.decode('utf-8')
                audio = generate(voice, text, maximum)
                send(b'O' + audio)
            except OverflowError:
                send(b'Espeech-audio-too-large')
            except Exception:
                send(b'Espeech-synthesis-failed')
            finally:
                data = b''
                text = ''
                audio = b''
    finally:
        # ONNX Runtime releases its session when the worker exits. Piper 1.8
        # exposes no explicit close API; no model files are modified.
        del voice


if __name__ == '__main__':
    main()
