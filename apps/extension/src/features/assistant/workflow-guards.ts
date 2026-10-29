import type { WorkflowStage, WorkflowState, WorkflowToken } from './workflow.types'
import { selectedItems } from './conversation-selectors'

const transitions: Record<WorkflowStage, WorkflowStage[]> = {
  idle: ['scanning'], scanning: ['collecting', 'stale', 'error', 'idle'], collecting: ['transcribing', 'interpreting', 'review', 'approving', 'scanning', 'error', 'stale', 'idle'],
  transcribing: ['collecting', 'error', 'stale', 'idle', 'scanning'], interpreting: ['collecting', 'review', 'error', 'stale', 'idle', 'scanning'],
  review: ['collecting', 'approving', 'filling', 'interpreting', 'scanning', 'error', 'stale', 'idle'], approving: ['review', 'collecting', 'error', 'stale', 'idle', 'scanning'],
  filling: ['results', 'error'], results: ['collecting', 'review', 'approving', 'scanning', 'stale', 'error', 'idle'], stale: ['scanning', 'idle', 'error'], error: ['collecting', 'review', 'scanning', 'stale', 'idle'],
}
export function canTransition(from: WorkflowStage, to: WorkflowStage) { return from === to || transitions[from].includes(to) }
export function tokenMatches(state: WorkflowState, token: WorkflowToken): boolean {
  return state.pending?.requestId === token.requestId && state.session?.sessionId === token.sessionId && state.scan?.inventory.scanId === token.scanId && state.revision === token.revision
}
export function liveContext(state: WorkflowState, now = Date.now()): boolean { return state.scan !== null && state.session !== null && !state.staleReason && state.session.origin === state.scan.inventory.origin && state.session.expiresAt > now }
export function canApprove(state: WorkflowState, now = Date.now()): boolean {
  return state.stage === 'review' && liveContext(state, now) && state.approved && state.review !== null && state.review.expiresAt > now && state.review.revision === state.revision && state.review.items.length > 0 && JSON.stringify(state.review.items) === JSON.stringify(selectedItems(state))
}
