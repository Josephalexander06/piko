"""Step 7 API, authentication, privacy, and loopback launch checks."""

import hashlib
import io
import runpy
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/local-service"))

from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock
from app.main import create_app
from app.services.piper_service import PiperService, PiperConfig

def no_speech():
    return PiperService(PiperConfig(voice_path=Path(__file__).parent / "fixtures/missing-voice.onnx"))

from app.auth import SESSION_TTL
from app.voice_config import VoiceConfig

ORIGIN = "chrome-extension://" + "a" * 32
OTHER = "chrome-extension://" + "b" * 32


class LauncherTests(unittest.TestCase):
    def test_default_launcher_is_loopback_only_without_access_logs_or_proxies(self):
        with patch("uvicorn.run") as run:
            runpy.run_module("app", run_name="__main__")
        run.assert_called_once_with("app.main:app", host="127.0.0.1", port=8765, reload=False, access_log=False, proxy_headers=False)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 1000.0
        self.announcements = []
        self.app = create_app(lambda: self.now, lambda: 1_800_000_000 + self.now, self.announcements.append, voice_config=VoiceConfig(), piper_service=no_speech())
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.addAsyncCleanup(self.lifespan.__aexit__, None, None, None)
        self.app.state.ollama.available = AsyncMock(return_value=False)
        self.code = self.announcements[0].split(": ")[-1]
        self.client = AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765", headers={"Origin": ORIGIN})
        self.addAsyncCleanup(self.client.aclose)

    async def pair(self):
        response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})
        self.assertEqual(response.status_code, 200)
        return response.json()["token"]

    async def test_health_without_authentication(self):
        response = await self.client.get("/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "local-voice-form-assistant", "version": "0.1.0", "inference": "local_ollama", "protocol_version": 1})
        self.assertEqual(response.headers["cache-control"], "no-store")
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765") as client:
            self.assertEqual((await client.get("/v1/health")).status_code, 200)

    async def test_pairing_and_authenticated_capabilities_ping(self):
        token = await self.pair()
        self.assertEqual(len(token), 43)
        self.assertNotEqual(token, self.code)
        self.assertEqual(self.app.state.pairing.session.token_digest, hashlib.sha256(token.encode()).digest())
        self.assertNotIn(token, repr(vars(self.app.state.pairing)))
        self.assertNotIn(self.code, repr(vars(self.app.state.pairing)))
        headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual((await self.client.get("/v1/ping", headers=headers)).json(), {"protocol_version": 1, "status": "ok"})
        self.assertEqual((await self.client.get("/v1/capabilities", headers=headers)).json(), {"protocol_version": 1, "inference": "unavailable", "transcription": "unavailable", "speech_synthesis": "unavailable", "speech_synthesis_detail": "speech-voice-missing"})

    async def test_invalid_code_does_not_create_session(self):
        response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": "0" * 16})
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(self.app.state.pairing.session)
        self.assertEqual(response.json(), {"error": "pairing_rejected"})

    async def test_pairing_code_expires_at_five_minutes(self):
        self.now += 300
        response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})
        self.assertEqual(response.status_code, 401)

    async def test_pairing_code_is_consumed_and_existing_session_survives_replay(self):
        token = await self.pair()
        response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code}, headers={"Origin": OTHER})
        self.assertEqual(response.status_code, 401)
        self.assertEqual((await self.client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})).status_code, 200)

    async def test_global_pairing_rate_limit_cannot_be_evaded_by_changing_extension_id(self):
        for index in range(5):
            response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": "0" * 16}, headers={"Origin": ORIGIN if index % 2 else OTHER})
            self.assertEqual(response.status_code, 401)
        response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "60")
        self.now += 60
        await self.pair()

    async def test_malformed_pairing_attempts_are_also_rate_limited(self):
        for _ in range(5):
            self.assertEqual((await self.client.post("/v1/pair", json={"code": "PRIVATE"})).status_code, 422)
        self.assertEqual((await self.client.post("/v1/pair", json={})).status_code, 429)

    async def test_protected_routes_require_independent_bearer_authentication(self):
        for route in ("/v1/ping", "/v1/capabilities", "/v1/session"):
            response = await self.client.request("DELETE" if route.endswith("session") else "GET", route)
            self.assertEqual(response.status_code, 401)
        await self.pair()
        for token in ("bad", "A" * 43, "A" * 500):
            self.assertEqual((await self.client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})).status_code, 401)

    async def test_origin_binding_rejects_even_a_correct_token_from_another_extension(self):
        token = await self.pair()
        headers = {"Authorization": f"Bearer {token}", "Origin": OTHER}
        self.assertEqual((await self.client.get("/v1/ping", headers=headers)).status_code, 403)
        self.assertEqual((await self.client.delete("/v1/session", headers=headers)).status_code, 403)
        self.assertEqual((await self.client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})).status_code, 200)

    async def test_missing_or_unsupported_origins_fail_closed(self):
        for origin in ("https://example.test", "null", ORIGIN + "/", "chrome-extension://" + "z" * 32, ""):
            response = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code}, headers={"Origin": origin})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("access-control-allow-origin", response.headers)

    async def test_expired_session(self):
        token = await self.pair()
        self.now += SESSION_TTL
        self.assertEqual((await self.client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})).status_code, 401)
        self.assertIsNone(self.app.state.pairing.session)

    async def test_privileged_extension_origin_declaration_for_chrome_gets(self):
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765", headers={"X-Piko-Extension-Origin": ORIGIN}) as client:
            paired = await client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})
            self.assertEqual(paired.status_code, 200)
            token = paired.json()["token"]
            headers = {"Authorization": f"Bearer {token}"}
            self.assertEqual((await client.get("/v1/ping", headers=headers)).status_code, 200)
            self.assertEqual((await client.get("/v1/ping", headers={**headers, "X-Piko-Extension-Origin": OTHER})).status_code, 403)
            for origin in ("https://example.test", OTHER):
                self.assertEqual((await client.get("/v1/ping", headers={**headers, "Origin": origin})).status_code, 403)
            self.assertEqual((await client.get("/v1/ping")).status_code, 401)

    async def test_disconnect_revokes_server_session_and_code_stays_consumed(self):
        token = await self.pair()
        headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual((await self.client.delete("/v1/session", headers=headers)).json(), {"protocol_version": 1, "status": "disconnected"})
        self.assertEqual((await self.client.get("/v1/ping", headers=headers)).status_code, 401)
        self.assertEqual((await self.client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})).status_code, 401)

    async def test_restart_invalidates_previous_code_and_token(self):
        token = await self.pair()
        restarted = create_app(announce=lambda _line: None, piper_service=no_speech())
        async with restarted.router.lifespan_context(restarted):
            async with AsyncClient(transport=ASGITransport(app=restarted), base_url="http://127.0.0.1:8765", headers={"Origin": ORIGIN}) as client:
                self.assertEqual((await client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})).status_code, 401)
                self.assertEqual((await client.post("/v1/pair", json={"protocol_version": 1, "code": self.code})).status_code, 401)

    async def test_cors_allows_only_extension_origins_and_required_headers_methods(self):
        headers = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type"}
        response = await self.client.options("/v1/pair", headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)
        self.assertNotIn("access-control-allow-credentials", response.headers)
        self.assertEqual((await self.client.options("/v1/pair", headers={**headers, "Origin": "https://example.test"})).status_code, 403)
        self.assertEqual((await self.client.options("/v1/pair", headers={**headers, "Access-Control-Request-Method": "PUT"})).status_code, 400)

    async def test_strict_models_and_malformed_json_do_not_echo_secrets(self):
        for content in ('{"code":"PRIVATE"}', '{"protocol_version":"1","code":"' + self.code + '"}', '{"protocol_version":true,"code":"' + self.code + '"}', '{"protocol_version":1,"code":"' + self.code + '","formValues":"PRIVATE"}', '{invalid PRIVATE'):
            response = await self.client.post("/v1/pair", content=content, headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("PRIVATE", response.text)
            self.assertNotIn(self.code, response.text)

    async def test_oversized_content_length_and_chunked_bodies_are_rejected(self):
        response = await self.client.post("/v1/pair", content=b"x" * 513, headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)
        response = await self.client.post("/v1/pair", content=b"", headers={"Content-Type": "application/json", "Content-Length": "9" * 100})
        self.assertEqual(response.status_code, 413)
        async def chunks():
            yield b"x" * 300
            yield b"x" * 300
        response = await self.client.post("/v1/pair", content=chunks(), headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

    async def test_wrong_content_type_query_and_unexpected_bodies_rejected(self):
        self.assertEqual((await self.client.post("/v1/pair", content=self.code)).status_code, 415)
        self.assertEqual((await self.client.get("/v1/ping?token=PRIVATE")).status_code, 400)
        self.assertEqual((await self.client.request("GET", "/v1/health", content="PRIVATE")).status_code, 400)
        self.assertEqual((await self.client.get("/v1/health", headers={"Host": "attacker.test"})).status_code, 403)
        self.assertEqual((await self.client.get("/v1/health", headers=[("Origin", ORIGIN), ("Origin", OTHER)])).status_code, 400)

    async def test_non_loopback_client_rejected_even_with_correct_host(self):
        async with AsyncClient(transport=ASGITransport(app=self.app, client=("192.0.2.1", 1234)), base_url="http://127.0.0.1:8765") as client:
            self.assertEqual((await client.get("/v1/health")).status_code, 403)

    async def test_unsupported_protocol(self):
        response = await self.client.post("/v1/pair", json={"protocol_version": 2, "code": self.code})
        self.assertEqual(response.status_code, 426)
        self.assertIsNone(self.app.state.pairing.session)

    async def test_only_intended_service_routes_and_no_remote_documentation(self):
        self.assertEqual(set(self.app.openapi()["paths"]), {"/v1/health", "/v1/pair", "/v1/ping", "/v1/capabilities", "/v1/session", "/v1/transcribe", "/v1/interpret", "/v1/synthesize"})
        for route in ("/interpret", "/api/v1/interpret", "/transcribe", "/synthesize", "/forms", "/docs", "/redoc", "/openapi.json"):
            self.assertEqual((await self.client.get(route)).status_code, 404)

    async def test_code_printed_only_once_and_requests_do_not_log_secrets(self):
        stream = io.StringIO()
        standalone = create_app(piper_service=no_speech())
        with redirect_stdout(stream), patch("logging.Logger._log") as log:
            async with standalone.router.lifespan_context(standalone):
                printed = stream.getvalue()
                self.assertEqual(printed.count("Piko pairing code"), 1)
            token = await self.pair()
            await self.client.get("/v1/ping", headers={"Authorization": f"Bearer {token}"})
        self.assertNotIn(token, stream.getvalue())
        self.assertNotIn(self.code, str(log.call_args_list))
        self.assertNotIn(token, str(log.call_args_list))


if __name__ == "__main__":
    unittest.main()
