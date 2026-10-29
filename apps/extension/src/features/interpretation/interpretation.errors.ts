import type { InterpretationErrorCode } from './interpretation.validation'

export const interpretationErrorLabels: Record<InterpretationErrorCode, string> = {
  'model-unavailable': 'The configured local Qwen model is unavailable. Check Ollama and the companion model configuration.',
  'interpretation-timeout': 'Local interpretation timed out. Your edited text is preserved; try a shorter answer.',
  'interpretation-busy': 'Another interpretation is running. Try again shortly.',
  'invalid-model-output': 'The model returned invalid output. No proposals were accepted. Edit your answer or retry.',
  'unknown-field-id': 'The model referenced an unknown field. No proposals were accepted.',
  'invalid-option-id': 'The model referenced an unavailable choice. No proposals were accepted.',
  'target-type-mismatch': 'The model proposed an incompatible value type. No proposals were accepted.',
  'duplicate-field-update': 'The model repeated a field. No proposals were accepted.',
  'unsupported-evidence': 'A proposal was not supported by your answer. No proposals were accepted. Use explicit wording or prepare it manually.',
  'proposal-validation-failed': 'A proposal failed field constraints. No proposals were accepted. Edit your answer or prepare it manually.',
  invalid_request: 'The request exceeds the supported field, option or text limits. Use manual answers.',
  body_too_large: 'This request is too large. Use a shorter answer or manual entry.',
  'request-cancelled': 'Interpretation cancelled. Your edited text is preserved.',
  'session-expired': 'The local session expired. Pair the companion again.',
  'service-unavailable': 'The local companion is unavailable. Start it and pair again.',
  'stale-scan': 'The page or scan changed. Inspect again before interpreting.',
  'invalid-response': 'The companion returned an invalid proposal. No proposals were accepted.',
}
