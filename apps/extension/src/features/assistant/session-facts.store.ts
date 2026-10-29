import { makeId } from '../scanner/scanner.messages'
import type { ScanField } from '../scanner/scanner.types'
import type { FillInstruction } from '../filling/fill.types'
import { FACT_TTL_MS, MAX_SESSION_FACTS, WORKFLOW_SESSION_KEY, type SessionSnapshot, type WorkflowContext } from './session-facts.types'
import { factValue, isSessionSnapshot } from './session-facts.validation'

/** Worker-owned serialized storage. Only confirmed facts and minimal metadata. */
export class SessionFactsStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly now = Date.now, private readonly invalidated: () => void = () => {}) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next
  }
  private async read(): Promise<SessionSnapshot | null> {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    const raw: unknown = (await chrome.storage.session.get(WORKFLOW_SESSION_KEY))[WORKFLOW_SESSION_KEY]
    if (raw === undefined) return null
    if (!isSessionSnapshot(raw, this.now())) { await chrome.storage.session.remove(WORKFLOW_SESSION_KEY); this.invalidated(); return null }
    return structuredClone(raw)
  }
  status() { return this.serial(() => this.read()) }
  ensure(origin: string) {
    return this.serial(async () => {
      const previous = await this.read()
      if (previous?.origin === origin) return previous
      const createdAt = this.now()
      const session: SessionSnapshot = { sessionId: makeId('session'), origin, createdAt, expiresAt: createdAt + FACT_TTL_MS, version: 1, facts: [] }
      if (!isSessionSnapshot(session, createdAt)) throw new Error('session-storage-unavailable')
      await chrome.storage.session.set({ [WORKFLOW_SESSION_KEY]: session })
      return session
    })
  }
  clear(sessionId: string | null) {
    return this.serial(async () => {
      const current = await this.read()
      if (sessionId !== null && current && current.sessionId !== sessionId) return false
      await chrome.storage.session.remove(WORKFLOW_SESSION_KEY); return true
    })
  }
  async matches(context: WorkflowContext, origin: string) {
    const session = await this.status()
    return session !== null && session.sessionId === context.sessionId && session.version === context.sessionVersion && session.origin === origin ? session : null
  }
  remember(context: WorkflowContext, origin: string, fields: ScanField[], items: FillInstruction[]) {
    return this.serial(async () => {
      const session = await this.read()
      if (!session || session.sessionId !== context.sessionId || session.version !== context.sessionVersion || session.origin !== origin) return { saved: 0, session }
      const facts = new Map(session.facts.map(fact => [fact.key, fact]))
      let saved = 0
      for (const item of items) {
        const field = fields.find(field => field.fieldId === item.fieldId)
        const candidate = field ? factValue(field, item) : null
        if (!candidate || facts.size >= MAX_SESSION_FACTS && !facts.has(candidate.key)) continue
        facts.set(candidate.key, { factId: makeId('fact'), ...candidate, source: 'user_confirmed', confirmedAt: this.now() }); saved++
      }
      if (!saved) return { saved, session }
      const next: SessionSnapshot = { ...session, version: session.version + 1, facts: [...facts.values()] }
      if (!isSessionSnapshot(next, this.now())) return { saved: 0, session: null }
      await chrome.storage.session.set({ [WORKFLOW_SESSION_KEY]: next })
      return { saved, session: next }
    })
  }
}
