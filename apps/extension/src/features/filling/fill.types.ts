import type { InterpretTarget } from '../interpretation/interpretation.generated'
import type { ScanFieldType } from '../scanner/scanner.types'

export type FillKind = ScanFieldType
export type FillValue = InterpretTarget
export interface FillInstruction { fieldId: string; target: FillValue; overwriteExisting: boolean }
export type FillStatus = 'filled' | 'already-matched' | 'blocked' | 'invalid' | 'stale' | 'rejected' | 'not-verified'
export interface FillItemResult { fieldId: string; status: FillStatus; reason?: FillReason }
export type FillReason = 'context' | 'expired' | 'replayed' | 'unknown-field' | 'ineligible' | 'type' | 'option' | 'constraint' | 'existing-value' | 'page-changed' | 'page-reverted' | 'unverified' | 'batch-invalid'
export interface FillBatchResult { batchId: string; status: 'completed' | 'rejected' | 'partial'; results: FillItemResult[] }
export interface FillPreflight { ok: boolean; results: FillItemResult[] }
export interface FillContext { tabId: number; scanId: string; documentId: string; origin: string }
export interface BoundInstruction extends FillInstruction { formId: string }
export interface FillAuthorization extends FillContext {
  batchId: string; issuedAt: number; expiresAt: number; items: BoundInstruction[]
}
export type FillPanelRequest =
  | { type: 'PIKO_FILL_REVIEW'; tabId: number; scanId: string; items: FillInstruction[] }
  | { type: 'PIKO_FILL_APPROVE'; reviewId: string }
  | { type: 'PIKO_FILL_CANCEL'; reviewId: string }
export type FillContentRequest =
  | { type: 'PIKO_FILL_PREFLIGHT'; context: FillContext; items: BoundInstruction[] }
  | { type: 'PIKO_FILL_COMMIT'; authorization: FillAuthorization }
export type FillResponse =
  | { ok: true; cancelled: true }
  | { ok: true; reviewId: string; expiresAt: number; preflight: FillPreflight }
  | { ok: true; result: FillBatchResult }
  | { ok: false; error: 'context' | 'expired' | 'invalid' | 'busy' | 'unavailable'; preflight?: FillPreflight }

// Both review and commit grants are intentionally short-lived and memory-only.
export const REVIEW_TTL_MS = 60_000
export const AUTHORIZATION_TTL_MS = 10_000
