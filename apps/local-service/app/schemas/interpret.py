"""Canonical Step 9 contract. Export JSON Schema and TS with scripts/generate-interpret-contracts.py."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Id = Annotated[str, Field(pattern=r"^[a-z]+_[a-f0-9]{32}$", max_length=64)]
Text = Annotated[str, Field(max_length=1024)]
Kind = Literal["text", "email", "tel", "number", "date", "textarea", "select", "radio", "checkbox"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TextTarget(StrictModel):
    kind: Literal["text", "email", "tel", "number", "date", "textarea"]
    value: Text


class OptionTarget(StrictModel):
    kind: Literal["select", "radio"]
    optionId: Id


class CheckboxTarget(StrictModel):
    kind: Literal["checkbox"]
    checked: bool


Target = TextTarget | OptionTarget | CheckboxTarget


class Constraints(StrictModel):
    minLength: int | None = Field(default=None, ge=0, le=1000000)
    maxLength: int | None = Field(default=None, ge=0, le=1000000)
    min: str | None = Field(default=None, max_length=128)
    max: str | None = Field(default=None, max_length=128)
    step: str | None = Field(default=None, max_length=128)
    patternPresent: bool | None = None


class Option(StrictModel):
    optionId: Id
    label: str = Field(min_length=1, max_length=128)


class EligibleField(StrictModel):
    fieldId: Id
    label: str = Field(min_length=1, max_length=256)
    type: Kind
    required: bool
    options: list[Option] = Field(max_length=50)
    constraints: Constraints

    @model_validator(mode="after")
    def options_match(self):
        if len({option.optionId for option in self.options}) != len(self.options):
            raise ValueError("duplicate_options")
        if (self.type in ("select", "radio")) != bool(self.options):
            raise ValueError("invalid_options")
        return self


class ApprovedFact(StrictModel):
    factId: Id
    text: str = Field(min_length=1, max_length=1024)


class InterpretRequest(StrictModel):
    scanId: Id
    transcript: str = Field(min_length=1, max_length=4096)
    knownFacts: list[ApprovedFact] = Field(max_length=50)
    fields: list[EligibleField] = Field(max_length=100)

    @model_validator(mode="after")
    def unique_and_bounded(self):
        def utf8(value):
            if isinstance(value, str):
                value.encode("utf-8")
            elif isinstance(value, list):
                for item in value:
                    utf8(item)
            elif isinstance(value, dict):
                for item in value.values():
                    utf8(item)
        try:
            utf8(self.model_dump())
        except UnicodeError:
            raise ValueError("invalid_unicode") from None
        if not self.transcript.strip():
            raise ValueError("empty_transcript")
        if len({field.fieldId for field in self.fields}) != len(self.fields):
            raise ValueError("duplicate_fields")
        if len({fact.factId for fact in self.knownFacts}) != len(self.knownFacts):
            raise ValueError("duplicate_facts")
        if sum(len(field.options) for field in self.fields) > 500:
            raise ValueError("too_many_options")
        return self


class Evidence(StrictModel):
    source: Literal["transcript", "fact"]
    factId: Id | None
    quote: str = Field(min_length=1, max_length=1024)


class Update(StrictModel):
    fieldId: Id
    target: Target
    evidence: Evidence


class Clarification(StrictModel):
    question: str = Field(min_length=1, max_length=500)
    targetFieldIds: list[Id] = Field(min_length=1, max_length=10)


class ModelProposal(StrictModel):
    updates: list[Update] = Field(max_length=100)
    clarifications: list[Clarification] = Field(max_length=10)


class MissingField(StrictModel):
    fieldId: Id
    question: str = Field(min_length=1, max_length=500)


class InterpretResponse(ModelProposal):
    scanId: Id
    missingFields: list[MissingField] = Field(max_length=100)
