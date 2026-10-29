"""Current-request-only interpretation and deterministic missing-information queue."""
import json
import asyncio
import logging
import time
from pathlib import Path
from pydantic import ValidationError
from ..schemas.interpret import InterpretRequest, InterpretResponse, MissingField, ModelProposal, Update
from .ollama_client import OllamaClient, InterpretationError, MAX_RESPONSE_BYTES, strict_json
from .proposal_validator import validate_proposal

PROMPT = (Path(__file__).parents[1] / "prompts/interpretation.txt").read_text()


def output_schema(request: InterpretRequest) -> dict:
    schema = ModelProposal.model_json_schema()
    variants = []
    for field in request.fields:
        update = Update.model_json_schema(ref_template="#/$defs/{model}")
        target = next(item for item in update["$defs"].values() if item.get("properties", {}).get("kind", {}).get("const") == "checkbox") if field.type == "checkbox" else None
        if target is None:
            target = next(item for item in update["$defs"].values() if field.type in item.get("properties", {}).get("kind", {}).get("enum", []))
        target = json.loads(json.dumps(target))
        target["properties"]["kind"] = {"const": field.type, "type": "string"}
        if field.type in ("text", "email", "tel", "number", "date", "textarea"):
            target["properties"]["value"]["minLength"] = 1
        if field.type == "number":
            target["properties"]["value"]["pattern"] = r"^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"
        if field.type == "date":
            target["properties"]["value"]["pattern"] = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
        if field.type in ("select", "radio"):
            target["properties"]["optionId"]["enum"] = [option.optionId for option in field.options]
        variants.append({"type": "object", "additionalProperties": False, "required": ["fieldId", "target", "evidence"], "properties": {
            "fieldId": {"const": field.fieldId, "type": "string"}, "target": target, "evidence": {"$ref": "#/$defs/Evidence"}}})
    schema["properties"]["updates"]["items"] = {"anyOf": variants} if variants else {"not": {}}
    schema["properties"]["updates"]["maxItems"] = len(request.fields)
    schema["$defs"]["Clarification"]["properties"]["targetFieldIds"]["items"]["enum"] = [field.fieldId for field in request.fields]
    return schema


class InterpretationService:
    def __init__(self, client: OllamaClient):
        self.client = client

    async def interpret(self, request: InterpretRequest) -> InterpretResponse:
        started = time.monotonic()
        category, size = "ok", 0
        try:
            if not request.fields:
                return InterpretResponse(scanId=request.scanId, updates=[], clarifications=[], missingFields=[])
            schema = output_schema(request)
            # No scan IDs, origin, titles, DOM, page values, credentials or history.
            content = json.dumps({"transcript": request.transcript, "knownFacts": [fact.model_dump() for fact in request.knownFacts],
                                  "fields": [field.model_dump(exclude_none=True) for field in request.fields]}, ensure_ascii=False)
            raw = await self.client.generate(PROMPT, content, schema)
            size = len(raw.encode("utf-8"))
            try:
                proposal = ModelProposal.model_validate(strict_json(raw))
            except (ValueError, ValidationError, RecursionError):
                raise InterpretationError("invalid-model-output", 502) from None
            validate_proposal(request, proposal)
            supplied = {update.fieldId for update in proposal.updates}
            missing = [MissingField(fieldId=field.fieldId, question=f"What should I enter for {field.label}?")
                       for field in request.fields if field.required and field.fieldId not in supplied]
            response = InterpretResponse(scanId=request.scanId, updates=proposal.updates, clarifications=proposal.clarifications, missingFields=missing)
            if len(response.model_dump_json().encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise InterpretationError("invalid-model-output", 502)
            return response
        except asyncio.CancelledError:
            category = "request-cancelled"
            raise
        except InterpretationError as error:
            category = error.code
            raise
        finally:
            logging.getLogger("piko.interpretation").info("interpretation elapsed_ms=%d response_bytes=%d category=%s", int((time.monotonic() - started) * 1000), size, category)
