"""Bound requests before JSON parsing; never echo request content in errors."""

import asyncio

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .auth import valid_origin

MAX_BODY_BYTES = 512


class RequestBoundary:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def safe_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
            await send(message)

        async def reject(status: int, error: str):
            await JSONResponse({"error": error}, status_code=status)(scope, receive, safe_send)

        raw_headers = scope.get("headers", [])
        if sum(len(key) + len(value) for key, value in raw_headers) > 8192:
            await reject(431, "headers_too_large")
            return
        for name in (b"host", b"origin", b"x-piko-extension-origin", b"authorization", b"content-length", b"content-type"):
            if sum(key == name for key, _ in raw_headers) > 1:
                await reject(400, "invalid_request")
                return
        headers = dict(raw_headers)
        client = scope.get("client")
        if headers.get(b"host", b"") not in (b"127.0.0.1:8765", b"127.0.0.1") or not client or client[0] not in ("127.0.0.1", "::1"):
            await reject(403, "loopback_only")
            return
        origin = headers.get(b"origin", b"").decode("latin1")
        declared = headers.get(b"x-piko-extension-origin", b"").decode("latin1")
        if (origin and not valid_origin(origin)) or (declared and not valid_origin(declared)) or (origin and declared and origin != declared):
            await reject(403, "unsupported_origin")
            return
        effective_origin = origin or declared
        scope.setdefault("state", {})["extension_origin"] = effective_origin
        if scope.get("query_string"):
            await reject(400, "query_not_supported")
            return
        if scope["path"] != "/v1/health" and not effective_origin:
            await reject(403, "unsupported_origin")
            return
        length = headers.get(b"content-length", b"0")
        if not length.isdigit():
            await reject(400, "invalid_request")
            return
        if len(length) > 10:
            await reject(413, "body_too_large")
            return
        if int(length) > MAX_BODY_BYTES:
            await reject(413, "body_too_large")
            return
        body = bytearray()
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            try:
                message = await asyncio.wait_for(receive(), timeout=max(0, deadline - asyncio.get_running_loop().time()))
            except asyncio.TimeoutError:
                await reject(408, "request_timeout")
                return
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_BODY_BYTES:
                await reject(413, "body_too_large")
                return
            if not message.get("more_body", False):
                break
        if body and not (scope["path"] == "/v1/pair" and scope["method"] == "POST"):
            await reject(400, "body_not_supported")
            return
        if scope["path"] == "/v1/pair" and scope["method"] == "POST" and headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() != b"application/json":
            await reject(415, "json_required")
            return

        async def bounded_receive():
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, bounded_receive, safe_send)
