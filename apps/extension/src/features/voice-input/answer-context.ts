import type { ScanField } from '../scanner/scanner.types'
import type { AnswerKind } from './transcription.types'

/** Only a fixed category reaches Whisper; never webpage labels or field values. */
export function answerKindForField(field: ScanField | undefined, confirming: boolean): AnswerKind {
  if (confirming) return 'confirmation'
  if (!field) return 'general'
  if (['email', 'tel', 'number', 'date'].includes(field.fieldType)) return field.fieldType as AnswerKind
  if (field.fieldType === 'text' && /\bname\b/i.test(field.label)) return 'name'
  return 'general'
}

export function answerPauseMs(kind: AnswerKind): number {
  return ['email', 'tel', 'number', 'date'].includes(kind) ? 4000 : 3000
}
