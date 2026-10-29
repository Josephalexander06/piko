"""Cancel delivery on disconnect; authenticate again before returning private audio."""
import asyncio
from fastapi import Request, Response
from ..schemas.synthesize import SynthesizeRequest
from ..services.piper_service import SpeechError


async def synthesize_request(payload: SynthesizeRequest, request: Request, authenticate) -> Response:
    job = asyncio.create_task(request.app.state.speech.synthesize(payload.text))
    disconnected = asyncio.create_task(request.receive())
    try:
        finished, _ = await asyncio.wait({job, disconnected}, return_when=asyncio.FIRST_COMPLETED)
        if disconnected in finished and disconnected.result().get('type') == 'http.disconnect':
            raise SpeechError('speech-cancelled', 499)
        audio = await job
        authenticate(request)
        return Response(audio, media_type='audio/wav', headers={'Cache-Control': 'no-store'})
    finally:
        for task in (job, disconnected):
            if not task.done():
                task.cancel()
        await asyncio.gather(job, disconnected, return_exceptions=True)
