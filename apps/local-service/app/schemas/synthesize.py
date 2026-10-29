"""Plain assistant text only. Never pass Piper/ESpeak directives through."""
import unicodedata
from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_TEXT_CHARS = 800
MAX_WAV_BYTES = 8 * 1024 * 1024
MAX_WAV_SECONDS = 120


def plain_text(text: str, maximum: int = MAX_TEXT_CHARS) -> str:
    if not text.strip() or len(text) > maximum:
        raise ValueError("invalid-speech-text")
    # Reject rather than silently changing what the visible message says.
    normalized = unicodedata.normalize("NFKC", text)
    if any(char in normalized for char in '<>[]{}') or any(unicodedata.category(char).startswith('C') for char in text):
        raise ValueError("invalid-speech-text")
    try:
        text.encode('utf-8')
    except UnicodeError:
        raise ValueError("invalid-speech-text") from None
    return text


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)

    @field_validator('text')
    @classmethod
    def valid_text(cls, value: str) -> str:
        return plain_text(value)
