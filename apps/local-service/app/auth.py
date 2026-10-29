"""Single-process, memory-only pairing and session authentication."""

import hashlib
import re
import secrets
from collections import deque
from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException

ORIGIN_PATTERN = r"chrome-extension://[a-p]{32}"
PAIRING_TTL = 5 * 60
SESSION_TTL = 12 * 60 * 60
ATTEMPT_WINDOW = 60
MAX_FAILURES = 5


def valid_origin(origin: str) -> bool:
    return re.fullmatch(ORIGIN_PATTERN, origin) is not None


def digest(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("ascii")).digest()


@dataclass(frozen=True)
class Session:
    token_digest: bytes
    origin: str
    deadline: float
    expires_at: int


class PairingManager:
    def __init__(self, clock: Callable[[], float], wall_clock: Callable[[], float]):
        self.clock = clock
        self.wall_clock = wall_clock
        self.code_digest: bytes | None = None
        self.code_deadline = 0.0
        self.session: Session | None = None
        self.failures: deque[float] = deque()

    def start(self) -> str:
        self.clear()
        code = secrets.token_hex(8)
        self.code_digest = digest(code)
        self.code_deadline = self.clock() + PAIRING_TTL
        return code

    def clear(self) -> None:
        self.code_digest = None
        self.session = None
        self.failures.clear()

    def check_rate(self) -> None:
        now = self.clock()
        while self.failures and self.failures[0] <= now - ATTEMPT_WINDOW:
            self.failures.popleft()
        if len(self.failures) >= MAX_FAILURES:
            raise HTTPException(429, "pairing_rate_limited", headers={"Retry-After": str(ATTEMPT_WINDOW)})

    def fail_pairing(self) -> None:
        self.check_rate()
        self.failures.append(self.clock())

    def pair(self, code: str, origin: str) -> tuple[str, int]:
        self.check_rate()
        if not valid_origin(origin):
            raise HTTPException(403, "unsupported_origin")
        if self.code_digest is None or self.clock() >= self.code_deadline or not secrets.compare_digest(self.code_digest, digest(code)):
            self.fail_pairing()
            raise HTTPException(401, "pairing_rejected")
        self.code_digest = None
        token = secrets.token_urlsafe(32)
        expires_at = int(self.wall_clock()) + SESSION_TTL
        self.session = Session(digest(token), origin, self.clock() + SESSION_TTL, expires_at)
        self.failures.clear()
        return token, expires_at

    def authenticate(self, authorization: str, origin: str) -> Session:
        if not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43}", authorization):
            raise HTTPException(401, "invalid_session")
        session = self.session
        if session is None or self.clock() >= session.deadline:
            self.session = None
            raise HTTPException(401, "invalid_session")
        if not secrets.compare_digest(session.token_digest, digest(authorization[7:])):
            raise HTTPException(401, "invalid_session")
        if not valid_origin(origin) or origin != session.origin:
            raise HTTPException(403, "origin_mismatch")
        return session
