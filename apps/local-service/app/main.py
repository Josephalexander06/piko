"""Step 7 authenticated loopback companion. No models or form-data endpoints."""

import time
from contextlib import asynccontextmanager
from typing import Annotated, Callable, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

from .auth import ORIGIN_PATTERN, PairingManager, Session
from .boundary import RequestBoundary


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    service: Literal["local-voice-form-assistant"] = "local-voice-form-assistant"
    version: Literal["0.1.0"] = "0.1.0"
    inference: Literal["not_integrated"] = "not_integrated"
    protocol_version: Literal[1] = 1


class PairRequest(StrictModel):
    protocol_version: int = Field(ge=1, le=10000)
    code: str = Field(min_length=16, max_length=16, pattern=r"^[a-f0-9]{16}$")


class PairResponse(StrictModel):
    protocol_version: Literal[1] = 1
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    expires_at: int


class CapabilitiesResponse(StrictModel):
    protocol_version: Literal[1] = 1
    inference: Literal["not_integrated"] = "not_integrated"
    transcription: Literal["not_integrated"] = "not_integrated"
    speech_synthesis: Literal["not_integrated"] = "not_integrated"


class PingResponse(StrictModel):
    protocol_version: Literal[1] = 1
    status: Literal["ok"] = "ok"


class DisconnectResponse(StrictModel):
    protocol_version: Literal[1] = 1
    status: Literal["disconnected"] = "disconnected"


def authenticate(request: Request) -> Session:
    return request.app.state.pairing.authenticate(request.headers.get("authorization", ""), request.state.extension_origin)


def create_app(clock: Callable[[], float] = time.monotonic, wall_clock: Callable[[], float] = time.time, announce: Callable[[str], None] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        manager = PairingManager(clock, wall_clock)
        application.state.pairing = manager
        code = manager.start()
        # The sole secret output is printed once to the startup terminal, never
        # through a logger. Request/error handlers never echo request content.
        line = f"Piko pairing code (valid for 5 minutes): {code}"
        if announce is None:
            print(line, flush=True)
        else:
            announce(line)
        del code, line
        try:
            yield
        finally:
            manager.clear()

    application = FastAPI(title="Local Voice Form Assistant Service", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    application.add_middleware(CORSMiddleware, allow_origin_regex=f"^{ORIGIN_PATTERN}$", allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type", "X-Piko-Extension-Origin"], allow_credentials=False, max_age=60)
    application.add_middleware(RequestBoundary)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, _error: RequestValidationError):
        if request.url.path == "/v1/pair":
            try:
                request.app.state.pairing.fail_pairing()
            except HTTPException as error:
                return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)
        return JSONResponse({"error": "invalid_request"}, status_code=422)

    @application.exception_handler(HTTPException)
    async def api_error(_request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)

    @application.get("/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse()

    @application.post("/v1/pair", response_model=PairResponse)
    async def pair(payload: PairRequest, request: Request) -> PairResponse:
        if payload.protocol_version != 1:
            raise HTTPException(426, "unsupported_protocol")
        token, expires_at = request.app.state.pairing.pair(payload.code, request.state.extension_origin)
        return PairResponse(token=token, expires_at=expires_at)

    @application.get("/v1/capabilities", response_model=CapabilitiesResponse)
    async def capabilities(_session: Annotated[Session, Depends(authenticate)]) -> CapabilitiesResponse:
        return CapabilitiesResponse()

    @application.get("/v1/ping", response_model=PingResponse)
    async def ping(_session: Annotated[Session, Depends(authenticate)]) -> PingResponse:
        return PingResponse()

    @application.delete("/v1/session", response_model=DisconnectResponse)
    async def disconnect(request: Request, _session: Annotated[Session, Depends(authenticate)]) -> DisconnectResponse:
        request.app.state.pairing.session = None
        return DisconnectResponse()

    return application


app = create_app()
