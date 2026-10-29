import type { ScanResult } from '../scanner/scanner.types'
import type { FillBatchResult, FillInstruction, FillPreflight } from '../filling/fill.types'
import type { Clarification, Evidence } from '../interpretation/interpretation.generated'
import type { SessionSnapshot } from './session-facts.types'

export type WorkflowStage = 'idle' | 'scanning' | 'collecting' | 'transcribing' | 'interpreting' | 'review' | 'approving' | 'filling' | 'results' | 'stale' | 'error'
export interface WorkflowToken { requestId: string; sessionId: string; scanId: string; revision: number }
export interface WorkflowDraft { text: string; selected: boolean; overwrite: boolean; source: 'manual' | 'model' | 'session'; protected: boolean }
export interface WorkflowReview { reviewId: string; expiresAt: number; revision: number; items: FillInstruction[] }
export interface WorkflowMessage { role: 'user' | 'assistant'; text: string }
export interface WorkflowState {
  stage: WorkflowStage; revision: number; mediaRevision: number; scan: ScanResult | null; session: SessionSnapshot | null
  scanRequest: string | null; pending: WorkflowToken | null; transcript: string
  drafts: Record<string, WorkflowDraft>; evidence: Record<string, Evidence>; clarifications: Clarification[]; skipped: string[]; verified: string[]
  messages: WorkflowMessage[]; review: WorkflowReview | null; approved: boolean; remember: boolean
  outcome: FillBatchResult | FillPreflight | null; error: string | null; staleReason: string | null
}
export interface QuestionItem { fieldId: string; scanId: string; question: string; spoken: string; ambiguous: boolean; skipped: boolean }
