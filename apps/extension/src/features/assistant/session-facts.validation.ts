import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import type { ScanField } from '../scanner/scanner.types'
import type { FillInstruction } from '../filling/fill.types'
import { FACT_TTL_MS, MAX_SESSION_FACTS, type FactKey, type SessionFact, type SessionSnapshot, type SessionRequest, type WorkflowContext } from './session-facts.types'

const labels: Record<string, FactKey> = { 'full name': 'full_name', name: 'full_name', 'first name': 'first_name', 'given name': 'first_name', 'last name': 'last_name', surname: 'last_name', email: 'email', 'email address': 'email', phone: 'phone', 'phone number': 'phone', telephone: 'phone', department: 'department', organization: 'organization', organisation: 'organization', company: 'organization', city: 'city', country: 'country' }
export function factKey(field: ScanField): FactKey | null {
  if (!field.eligible || !field.visible || !field.enabled || field.readOnly || field.labelUncertain || field.exclusionReasons.length) return null
  const key = labels[field.label.trim().toLowerCase().replace(/\s+/g, ' ')]
  if (!key) return null
  if (key === 'email') return field.fieldType === 'email' ? key : null
  if (key === 'phone') return field.fieldType === 'tel' ? key : null
  return ['text', 'select', 'radio'].includes(field.fieldType) ? key : null
}
function safeValue(key: FactKey, value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\p{C}<>[\]{}]/u.test(value) || /(?:bearer\s|password|passwd|otp|one.time.code|private.key|-----BEGIN)/i.test(value)) return false
  if (/\d(?:[\s-]*\d){12,18}/.test(value)) return false
  if (key === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (key === 'phone') return /^\+?[\d ()-]{7,24}$/.test(value) && (value.match(/\d/g)?.length ?? 0) <= 12
  return /\p{L}/u.test(value) && !/^\d+$/.test(value)
}
export function factValue(field: ScanField, item: FillInstruction): { key: FactKey; value: string } | null {
  const key = factKey(field)
  if (!key || item.fieldId !== field.fieldId || item.target.kind !== field.fieldType) return null
  const value = 'value' in item.target ? item.target.value : 'optionId' in item.target ? field.options.find(option => option.optionId === ('optionId' in item.target ? item.target.optionId : '') && !option.disabled)?.label : undefined
  return safeValue(key, value) ? { key, value } : null
}
export function isWorkflowContext(value: unknown): value is WorkflowContext {
  return isRecord(value) && hasKeys(value, ['sessionId', 'sessionVersion', 'revision']) && isOpaqueId(value.sessionId) && Number.isSafeInteger(value.sessionVersion) && Number(value.sessionVersion) >= 1 && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
}
export function isSessionSnapshot(value: unknown, now = Date.now()): value is SessionSnapshot {
  if (!isRecord(value) || !hasKeys(value, ['sessionId', 'origin', 'createdAt', 'expiresAt', 'version', 'facts']) || !isOpaqueId(value.sessionId) || typeof value.origin !== 'string' || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) > now || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= now || Number(value.expiresAt) !== Number(value.createdAt) + FACT_TTL_MS || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !Array.isArray(value.facts) || value.facts.length > MAX_SESSION_FACTS || new TextEncoder().encode(JSON.stringify(value)).length > 16384) return false
  try { const url = new URL(value.origin); if (url.origin !== value.origin || !['http:', 'https:'].includes(url.protocol)) return false } catch { return false }
  const keys = new Set<string>()
  return value.facts.every((fact: unknown) => {
    if (!isRecord(fact) || !hasKeys(fact, ['factId', 'key', 'value', 'source', 'confirmedAt']) || !isOpaqueId(fact.factId) || !Object.values(labels).includes(fact.key as FactKey) || !safeValue(fact.key as FactKey, fact.value) || fact.source !== 'user_confirmed' || !Number.isSafeInteger(fact.confirmedAt) || Number(fact.confirmedAt) < Number(value.createdAt) || Number(fact.confirmedAt) > now || keys.has(String(fact.key))) return false
    keys.add(String(fact.key)); return true
  }) && new Set(value.facts.map((fact: SessionFact) => fact.factId)).size === value.facts.length
}
export function isSessionRequest(value: unknown): value is SessionRequest {
  if (!isRecord(value) || !isOpaqueId(value.requestId)) return false
  if (value.type === 'PIKO_SESSION_STATUS') return hasKeys(value, ['type', 'requestId'])
  if (value.type === 'PIKO_SESSION_CLEAR') return hasKeys(value, ['type', 'requestId', 'sessionId']) && (value.sessionId === null || isOpaqueId(value.sessionId))
  return value.type === 'PIKO_SESSION_ENSURE' && hasKeys(value, ['type', 'requestId', 'tabId', 'scanId']) && Number.isSafeInteger(value.tabId) && Number(value.tabId) >= 0 && isOpaqueId(value.scanId)
}
