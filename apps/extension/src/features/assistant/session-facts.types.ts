export const WORKFLOW_SESSION_KEY = 'piko.assistant.session.v1'
export const FACT_TTL_MS = 30 * 60 * 1000
export const MAX_SESSION_FACTS = 20
export type FactKey = 'full_name' | 'first_name' | 'last_name' | 'email' | 'phone' | 'department' | 'organization' | 'city' | 'country'
export interface SessionFact { factId: string; key: FactKey; value: string; source: 'user_confirmed'; confirmedAt: number }
export interface SessionSnapshot { sessionId: string; origin: string; createdAt: number; expiresAt: number; version: number; facts: SessionFact[] }
export interface WorkflowContext { sessionId: string; sessionVersion: number; revision: number }
export type SessionRequest =
  | { type: 'PIKO_SESSION_STATUS'; requestId: string }
  | { type: 'PIKO_SESSION_CLEAR'; requestId: string; sessionId: string | null }
  | { type: 'PIKO_SESSION_ENSURE'; requestId: string; tabId: number; scanId: string }
export type SessionReply = { ok: true; requestId: string; session: SessionSnapshot | null } | { ok: false; requestId: string; error: 'session-storage-unavailable' | 'stale-scan' | 'session-expired' }
