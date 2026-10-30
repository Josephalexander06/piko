"""Bounded local-only Ollama transport. Never log input or raw upstream errors."""
import asyncio
import json
import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit
import httpx

MAX_RESPONSE_BYTES = 131072


class InterpretationError(Exception):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


@dataclass(frozen=True)
class OllamaConfig:
    base_url: str = "http://127.0.0.1:11434"
    model: str = "qwen2.5:14b"
    timeout: float = 60
    max_concurrency: int = 1

    def __post_init__(self):
        try:
            url = urlsplit(self.base_url)
            valid = (url.scheme == "http" and url.hostname in ("127.0.0.1", "::1") and url.port is not None
                     and 1 <= url.port <= 65535 and not url.username and not url.password
                     and not url.path and not url.query and not url.fragment)
        except ValueError:
            valid = False
        if (not valid or not re.fullmatch(r"(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}/)?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", self.model)
                or "cloud" in self.model.lower() or self.model.count(":") != 1
                or not 1 <= self.timeout <= 120 or self.max_concurrency != 1):
            raise ValueError("invalid_ollama_configuration")

    @classmethod
    def load(cls):
        try:
            return cls(os.environ.get("OLLAMA_BASE_URL", cls.base_url).rstrip("/"),
                       os.environ.get("OLLAMA_MODEL", cls.model),
                       float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "60")),
                       int(os.environ.get("OLLAMA_MAX_CONCURRENCY", "1")))
        except (ValueError, TypeError):
            raise ValueError("invalid_ollama_configuration") from None


def strict_json(raw: str | bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result
    def constant(_value):
        raise ValueError("invalid_number")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


class OllamaClient:
    def __init__(self, config: OllamaConfig | None = None, transport=None):
        self.config = config or OllamaConfig.load()
        self.http = httpx.AsyncClient(base_url=self.config.base_url, trust_env=False, follow_redirects=False, transport=transport)
        self.lock = asyncio.Lock()

    async def close(self):
        await self.http.aclose()

    async def _json(self, method: str, path: str, payload=None, timeout: float | None = None):
        async with self.http.stream(method, path, json=payload, timeout=timeout or self.config.timeout) as response:
            if response.status_code == 404:
                raise InterpretationError("model-unavailable", 503)
            if response.status_code != 200:
                raise InterpretationError("model-unavailable", 503)
            if response.headers.get("content-type", "").split(";")[0] != "application/json":
                raise InterpretationError("invalid-model-output", 502)
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_RESPONSE_BYTES:
                    raise InterpretationError("invalid-model-output", 502)
            try:
                return strict_json(bytes(data))
            except (ValueError, UnicodeError, RecursionError):
                raise InterpretationError("invalid-model-output", 502) from None

    async def available(self) -> bool:
        try:
            async with asyncio.timeout(2):
                listing = await self._json("GET", "/api/tags", timeout=2)
                present = isinstance(listing, dict) and any(
                    isinstance(model, dict) and model.get("name") == self.config.model
                    and not model.get("remote_host") and not model.get("remote_model")
                    for model in listing.get("models", []) if isinstance(listing.get("models"), list))
                if not present:
                    return False
                details = await self._json("POST", "/api/show", {"model": self.config.model}, timeout=2)
                return (isinstance(details, dict) and not details.get("remote_host") and not details.get("remote_model")
                        and isinstance(details.get("model_info"), dict) and bool(details["model_info"].get("general.architecture")))
        except (httpx.HTTPError, TimeoutError, InterpretationError, TypeError):
            return False

    async def generate(self, prompt: str, content: str, schema: dict) -> str:
        if self.lock.locked():
            raise InterpretationError("interpretation-busy", 429)
        async with self.lock:
            try:
                async with asyncio.timeout(self.config.timeout):
                    if not await self.available():
                        raise InterpretationError("model-unavailable", 503)
                    result = await self._json("POST", "/api/chat", {
                        "model": self.config.model,
                        "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": content}],
                        "format": schema, "stream": False, "think": False,
                        "options": {"temperature": 0, "seed": 0, "num_predict": 8192, "num_ctx": 16384},
                    })
                    message = result.get("message") if isinstance(result, dict) else None
                    if (not isinstance(message, dict) or message.get("role") != "assistant"
                            or not isinstance(message.get("content"), str) or message.get("tool_calls")
                            or result.get("done") is not True or result.get("done_reason", "stop") != "stop"
                            or result.get("model") != self.config.model):
                        raise InterpretationError("invalid-model-output", 502)
                    return message["content"]
            except (httpx.TimeoutException, TimeoutError):
                raise InterpretationError("interpretation-timeout", 504) from None
            except httpx.HTTPError:
                raise InterpretationError("model-unavailable", 503) from None
