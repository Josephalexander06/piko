import { isWorkflowContext } from '../assistant/session-facts.validation'
import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import type { BoundInstruction, FillAuthorization, FillBatchResult, FillContentRequest, FillContext, FillInstruction, FillPanelRequest, FillPreflight, FillValue } from './fill.types'
import { AUTHORIZATION_TTL_MS } from './fill.types'

export function isFillValue(value: unknown): value is FillValue {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (['text', 'email', 'tel', 'number', 'date', 'textarea'].includes(value.kind)) return hasKeys(value, ['kind', 'value']) && typeof value.value === 'string' && value.value.length <= 1024
  if (value.kind === 'select' || value.kind === 'radio') return hasKeys(value, ['kind', 'optionId']) && isOpaqueId(value.optionId)
  return value.kind === 'checkbox' && hasKeys(value, ['kind', 'checked']) && typeof value.checked === 'boolean'
}
export function isInstructions(value: unknown, bound = false): value is FillInstruction[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && new Set(value.map((item: unknown) => isRecord(item) ? item.fieldId : null)).size === value.length && Array.from(value).every((item: unknown) => isRecord(item) && hasKeys(item, bound ? ['fieldId', 'formId', 'target', 'overwriteExisting'] : ['fieldId', 'target', 'overwriteExisting']) && isOpaqueId(item.fieldId) && (!bound || isOpaqueId(item.formId)) && isFillValue(item.target) && typeof item.overwriteExisting === 'boolean')
}
export function isFillContext(value: unknown): value is FillContext {
  if (!isRecord(value) || !hasKeys(value, ['tabId', 'scanId', 'documentId', 'origin']) || !Number.isSafeInteger(value.tabId) || Number(value.tabId) < 0 || !isOpaqueId(value.scanId) || !isOpaqueId(value.documentId) || typeof value.origin !== 'string') return false
  try { const url = new URL(value.origin); return value.origin.length <= 2048 && ['http:', 'https:'].includes(url.protocol) && url.origin === value.origin } catch { return false }
}
export function contextOf(value: FillContext): FillContext {
  return { tabId: value.tabId, scanId: value.scanId, documentId: value.documentId, origin: value.origin }
}
export function isAuthorization(value: unknown): value is FillAuthorization {
  return isRecord(value) && hasKeys(value, ['tabId', 'scanId', 'documentId', 'origin', 'batchId', 'issuedAt', 'expiresAt', 'items']) && isFillContext(contextOf(value as unknown as FillContext)) && isOpaqueId(value.batchId) && Number.isSafeInteger(value.issuedAt) && Number(value.issuedAt) >= 0 && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > Number(value.issuedAt) && Number(value.expiresAt) - Number(value.issuedAt) <= AUTHORIZATION_TTL_MS && isInstructions(value.items, true)
}
export function isFillPanelRequest(value: unknown): value is FillPanelRequest {
  if (!isRecord(value)) return false
  if (value.type === 'PIKO_FILL_CANCEL') return hasKeys(value, ['type', 'reviewId']) && isOpaqueId(value.reviewId)
  if (value.type === 'PIKO_FILL_APPROVE') return isOpaqueId(value.reviewId) && (hasKeys(value, ['type', 'reviewId']) || hasKeys(value, ['type', 'reviewId', 'workflow', 'rememberSelected']) && isWorkflowContext(value.workflow) && typeof value.rememberSelected === 'boolean')
  return value.type === 'PIKO_FILL_REVIEW' && (hasKeys(value, ['type', 'tabId', 'scanId', 'items']) || hasKeys(value, ['type', 'tabId', 'scanId', 'items', 'workflow']) && isWorkflowContext(value.workflow)) && Number.isSafeInteger(value.tabId) && Number(value.tabId) >= 0 && isOpaqueId(value.scanId) && isInstructions(value.items)
}
export function isFillContentRequest(value: unknown): value is FillContentRequest {
  return isRecord(value) && (value.type === 'PIKO_FILL_PREFLIGHT' ? hasKeys(value, ['type', 'context', 'items']) && isFillContext(value.context) && isInstructions(value.items, true) : value.type === 'PIKO_FILL_COMMIT' && hasKeys(value, ['type', 'authorization']) && isAuthorization(value.authorization))
}
const reasons = ['context', 'expired', 'replayed', 'unknown-field', 'ineligible', 'type', 'option', 'constraint', 'existing-value', 'page-changed', 'page-reverted', 'unverified', 'batch-invalid']
function isResults(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && new Set(value.map((item: unknown) => isRecord(item) ? item.fieldId : null)).size === value.length && Array.from(value).every((item: unknown) => isRecord(item) && hasKeys(item, item.reason === undefined ? ['fieldId', 'status'] : ['fieldId', 'status', 'reason']) && isOpaqueId(item.fieldId) && typeof item.status === 'string' && ['filled', 'already-matched', 'blocked', 'invalid', 'stale', 'rejected', 'not-verified'].includes(item.status) && (item.reason === undefined || typeof item.reason === 'string' && reasons.includes(item.reason)))
}
export function isPreflight(value: unknown, items: FillInstruction[]): value is FillPreflight {
  return isRecord(value) && hasKeys(value, ['ok', 'results']) && typeof value.ok === 'boolean' && isResults(value.results) && Array.isArray(value.results) && value.results.length === items.length && value.results.every((result, index) => result.fieldId === items[index].fieldId && (value.ok ? result.status === 'already-matched' || (result.status === 'not-verified' && result.reason === undefined) : true))
}
export function isBatchResult(value: unknown, batchId?: string, items?: BoundInstruction[]): value is FillBatchResult {
  return isRecord(value) && hasKeys(value, ['batchId', 'status', 'results']) && isOpaqueId(value.batchId) && (!batchId || value.batchId === batchId) && typeof value.status === 'string' && ['completed', 'rejected', 'partial'].includes(value.status) && isResults(value.results) && Array.isArray(value.results) && (!items || value.results.length === items.length && value.results.every((item, index) => item.fieldId === items[index].fieldId)) && (value.status !== 'completed' || value.results.every((item) => ['filled', 'already-matched'].includes(item.status)))
}
