import type { WorkflowContext, SessionSnapshot } from '../features/assistant/session-facts.types'
import type { ScanField } from '../features/scanner/scanner.types'
import { makeId } from '../features/scanner/scanner.messages'
import type { ScanInventory } from '../features/scanner/scanner.types'
import type { BoundInstruction, FillContext, FillInstruction, FillPanelRequest, FillResponse } from '../features/filling/fill.types'
import { AUTHORIZATION_TTL_MS, REVIEW_TTL_MS } from '../features/filling/fill.types'
import { isBatchResult, isPreflight } from '../features/filling/fill.validation'

export interface FillSession { scanId: string; documentId: string; chromeDocumentId: string; inventory: ScanInventory }
interface Review { workflow?: WorkflowContext; context: FillContext; session: FillSession; items: BoundInstruction[]; expiresAt: number }
export function fromPanel(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false
  try { const url = new URL(sender.url); return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && url.pathname === '/src/sidepanel/index.html' && !url.search && !url.hash } catch { return false }
}
export class ApprovalCoordinator {
  private reviews = new Map<string, Review>()
  private busy = new Set<number>()
  constructor(private readonly sessions: Map<number, FillSession>, private readonly now = Date.now, private readonly memory?: { verify: (context: WorkflowContext, origin: string) => Promise<boolean>; remember: (context: WorkflowContext, origin: string, fields: ScanField[], items: FillInstruction[]) => Promise<{ saved: number; session: SessionSnapshot | null }> }) {}
  invalidate(tabId: number): void { for (const [id, review] of this.reviews) if (review.context.tabId === tabId) this.reviews.delete(id) }
  private async current(review: Review): Promise<boolean> {
    if (this.sessions.get(review.context.tabId) !== review.session) return false
    const tab = await chrome.tabs.get(review.context.tabId)
    if (!tab.url || new URL(tab.url).origin !== review.context.origin || tab.pendingUrl) return false
    const response: unknown = await chrome.tabs.sendMessage(review.context.tabId, { type: 'PIKO_SCAN_CURRENT', scanId: review.context.scanId, documentId: review.context.documentId }, { documentId: review.session.chromeDocumentId })
    return this.sessions.get(review.context.tabId) === review.session && typeof response === 'object' && response !== null && 'current' in response && response.current === true
  }
  async handle(request: FillPanelRequest): Promise<FillResponse> {
    try {
      if (request.type === 'PIKO_FILL_CANCEL') { this.reviews.delete(request.reviewId); return { ok: true, cancelled: true } }
      for (const [id, review] of this.reviews) if (this.now() >= review.expiresAt) this.reviews.delete(id)
      if (request.type === 'PIKO_FILL_REVIEW') {
        const session = this.sessions.get(request.tabId)
        if (!session || session.scanId !== request.scanId) return { ok: false, error: 'context' }
        if (this.busy.has(request.tabId)) return { ok: false, error: 'busy' }
        this.invalidate(request.tabId)
        const items: BoundInstruction[] = []
        for (const item of request.items) {
          const form = session.inventory.forms.find((form) => form.fields.some((field) => field.fieldId === item.fieldId && field.eligible && field.fieldType === item.target.kind))
          if (!form) return { ok: false, error: 'invalid' }
          const field = form.fields.find((field) => field.fieldId === item.fieldId)!
          if ('optionId' in item.target && !field.options.some((option) => option.optionId === ('optionId' in item.target ? item.target.optionId : '') && !option.disabled)) return { ok: false, error: 'invalid' }
          items.push({ ...structuredClone(item), formId: form.formId })
        }
        if (request.workflow && (!this.memory || !await this.memory.verify(request.workflow, session.inventory.origin))) return { ok: false, error: 'context' }
        const review: Review = { ...(request.workflow ? { workflow: request.workflow } : {}), context: { tabId: request.tabId, scanId: session.scanId, documentId: session.documentId, origin: session.inventory.origin }, session, items, expiresAt: this.now() + REVIEW_TTL_MS }
        if (!await this.current(review)) return { ok: false, error: 'context' }
        const preflight: unknown = await chrome.tabs.sendMessage(request.tabId, { type: 'PIKO_FILL_PREFLIGHT', context: review.context, items }, { documentId: session.chromeDocumentId })
        if (!isPreflight(preflight, items)) return { ok: false, error: 'invalid' }
        if (!preflight.ok) return { ok: false, error: 'invalid', preflight }
        if (this.sessions.get(request.tabId) !== session) return { ok: false, error: 'context' }
        // Only the last successful review for a tab can remain approvable.
        this.invalidate(request.tabId)
        const reviewId = makeId('review')
        this.reviews.set(reviewId, review)
        setTimeout(() => this.reviews.delete(reviewId), REVIEW_TTL_MS)
        return { ok: true, reviewId, expiresAt: review.expiresAt, preflight }
      }
      const review = this.reviews.get(request.reviewId)
      this.reviews.delete(request.reviewId) // One use, even on failure.
      if (!review) return { ok: false, error: 'expired' }
      const tabId = review.context.tabId
      if (this.busy.has(tabId)) return { ok: false, error: 'busy' }
      this.busy.add(tabId)
      try {
        if (!await this.current(review)) return { ok: false, error: 'context' }
        if (review.workflow && (!request.workflow || JSON.stringify(review.workflow) !== JSON.stringify(request.workflow) || !this.memory || !await this.memory.verify(review.workflow, review.context.origin))) return { ok: false, error: 'context' }
        if (!review.workflow && request.workflow) return { ok: false, error: 'context' }
        if (this.now() >= review.expiresAt) return { ok: false, error: 'expired' }
        const issuedAt = this.now()
        const authorization = { ...review.context, batchId: makeId('batch'), issuedAt, expiresAt: issuedAt + AUTHORIZATION_TTL_MS, items: review.items }
        // Grant exists only for this delivery. There is no retry or persisted token.
        const result: unknown = await chrome.tabs.sendMessage(tabId, { type: 'PIKO_FILL_COMMIT', authorization }, { documentId: review.session.chromeDocumentId })
        if (!isBatchResult(result, authorization.batchId, review.items)) return { ok: false, error: 'unavailable' }
        if (review.workflow && request.rememberSelected && this.memory) {
          const successful = review.items.filter(item => result.results.some(outcome => outcome.fieldId === item.fieldId && ['filled', 'already-matched'].includes(outcome.status)))
          try {
            const memory = await this.memory.remember(review.workflow, review.context.origin, review.session.inventory.forms.flatMap(form => form.fields), successful)
            return { ok: true, result, memory }
          } catch { return { ok: true, result, memory: { saved: 0, session: null } } }
        }
        return { ok: true, result }
      } finally { this.busy.delete(tabId) }
    } catch { return { ok: false, error: 'unavailable' } }
  }
}
