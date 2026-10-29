"""Independent registry, evidence and native-metadata validation. No repairs."""
import datetime
import re
from decimal import Decimal, InvalidOperation
from ..schemas.interpret import InterpretRequest, ModelProposal, TextTarget, OptionTarget, CheckboxTarget
from .ollama_client import InterpretationError


def fail(code="proposal-validation-failed"):
    raise InterpretationError(code, 502)


def normalized(text: str) -> str:
    return " ".join(text.casefold().split())


def validate_proposal(request: InterpretRequest, proposal: ModelProposal):
    fields = {field.fieldId: field for field in request.fields}
    facts = {fact.factId: fact.text for fact in request.knownFacts}
    seen = set()
    for update in proposal.updates:
        field = fields.get(update.fieldId)
        if field is None:
            fail("unknown-field-id")
        if update.fieldId in seen:
            fail("duplicate-field-update")
        seen.add(update.fieldId)
        target, evidence = update.target, update.evidence
        if target.kind != field.type:
            fail("target-type-mismatch")
        source = request.transcript if evidence.source == "transcript" and evidence.factId is None else facts.get(evidence.factId) if evidence.source == "fact" else None
        if source is None or evidence.quote not in source or not evidence.quote.strip():
            fail("unsupported-evidence")
        quote = normalized(evidence.quote)
        offset = source.index(evidence.quote)
        before = re.split(r"[.!?;\n]", source[:offset])[-1]
        after = re.split(r"[.!?;\n]", source[offset + len(evidence.quote):])[0]
        context = normalized(before + evidence.quote + after)
        if re.search(r"\b(maybe|might|uncertain|not certain|not sure|could be|either|possibly)\b", context):
            fail("unsupported-evidence")
        if not isinstance(target, CheckboxTarget) and re.search(r"\b(not|never|don't|isn't|is not)\b", context):
            fail("unsupported-evidence")
        if isinstance(target, OptionTarget):
            option = next((option for option in field.options if option.optionId == target.optionId), None)
            if option is None:
                fail("invalid-option-id")
            if normalized(option.label) not in quote:
                fail("unsupported-evidence")
        elif isinstance(target, CheckboxTarget):
            # Conservative evidence gate; semantic intent still requires review.
            positive = bool(re.search(r"\b(yes|true|checked|check|want|need|have)\b", context))
            negative = bool(re.search(r"\b(no|false|unchecked|uncheck|not|never|don't|do not)\b", context))
            if (target.checked and (not positive or negative)) or (not target.checked and not negative):
                fail("unsupported-evidence")
            if field.required and not target.checked:
                fail()
        elif isinstance(target, TextTarget):
            value, limits = target.value, field.constraints
            try:
                value.encode("utf-8")
            except UnicodeError:
                fail()
            if not value.strip() or normalized(value) not in quote:
                fail("unsupported-evidence")
            length = len(value.encode("utf-16-le")) // 2
            if (limits.minLength is not None and length < limits.minLength) or (limits.maxLength is not None and length > limits.maxLength):
                fail()
            if field.type != "textarea" and any(char in value for char in "\r\n"):
                fail()
            if field.type == "email" and not re.fullmatch(r"[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*", value):
                fail()
            if field.type in ("number", "date"):
                try:
                    if field.type == "date":
                        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                            fail()
                        parsed = Decimal(datetime.date.fromisoformat(value).toordinal())
                        def bound(text):
                            return Decimal(datetime.date.fromisoformat(text).toordinal())
                        base = Decimal(datetime.date(1970, 1, 1).toordinal())
                    else:
                        if not re.fullmatch(r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value) or len(value) > 128:
                            fail()
                        parsed = Decimal(value)
                        bound = Decimal
                        base = Decimal(0)
                    if not parsed.is_finite():
                        fail()
                    if limits.min is not None:
                        base = bound(limits.min)
                        if not base.is_finite() or parsed < base:
                            fail()
                    if limits.max is not None:
                        maximum = bound(limits.max)
                        if not maximum.is_finite() or parsed > maximum:
                            fail()
                    if limits.step != "any":
                        step = Decimal(limits.step or "1")
                        if not step.is_finite() or step <= 0 or (parsed - base) % step != 0:
                            fail()
                except (ValueError, InvalidOperation, OverflowError):
                    fail()
    clarification_ids = set()
    for clarification in proposal.clarifications:
        ids = clarification.targetFieldIds
        if len(set(ids)) != len(ids) or any(field_id not in fields for field_id in ids):
            fail("unknown-field-id")
        if seen.intersection(ids) or clarification_ids.intersection(ids):
            fail("proposal-validation-failed")
        clarification_ids.update(ids)
