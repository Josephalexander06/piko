import scannerFile from '../content/form-scanner?script&iife'
import { isContentStale, isInspectRequest, isRecord, isStopRequest, makeId } from '../features/scanner/scanner.messages'
import { isScanInventory } from '../features/scanner/scanner.validation'
import type { InspectRequest, InspectResponse } from '../features/scanner/scanner.messages'
import type { InvalidationReason, ScanError, ScanInventory } from '../features/scanner/scanner.types'
import { ApprovalCoordinator, fromPanel, type FillSession } from './approval-coordinator'
import { isFillPanelRequest } from '../features/filling/fill.validation'
import { ConnectionManager } from './connection-manager'
import { isConnectionRequest } from '../features/local-service/connection.validation'
import { AudioTransfer } from './audio-transfer'
import { VOICE_PORT } from '../features/voice-input/transcription.types'

const connection = new ConnectionManager()
let activeAudio: AudioTransfer | null = null
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== VOICE_PORT || !fromPanel(port.sender ?? {}) || activeAudio) { port.disconnect(); return }
  const transfer = new AudioTransfer((reply) => { try { port.postMessage(reply) } catch { transfer.dispose() } }, (audio, signal) => connection.transcribeAudio(audio, signal), () => { if (activeAudio === transfer) activeAudio = null })
  activeAudio = transfer
  port.onMessage.addListener((message: unknown) => { void transfer.receive(message) })
  port.onDisconnect.addListener(() => transfer.dispose())
})

// The automatic side-panel path can consume the action without granting
// activeTab. An explicit action handler preserves the permission-grant gesture.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => console.error('PIKO_SIDE_PANEL_CONFIGURATION_FAILED'))
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  // Call synchronously within the user gesture, before any awaited work.
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => console.error('PIKO_SIDE_PANEL_OPEN_FAILED'))
})
type Session = FillSession
const sessions = new Map<number, Session>()
const approvals = new ApprovalCoordinator(sessions)
const pending = new Map<number, string>()

function release(tabId: number, session: Session) {
  void chrome.tabs.sendMessage(tabId, { type: 'PIKO_SCAN_RELEASE', scanId: session.scanId }, { documentId: session.chromeDocumentId }).catch(() => {})
}
function invalidate(tabId: number, reason: InvalidationReason, releaseReferences = true) {
  approvals.invalidate(tabId)
  pending.delete(tabId)
  const session = sessions.get(tabId)
  if (!session) {
    // MV3 workers can restart with empty maps while a panel still has metadata.
    if (reason === 'navigation' || reason === 'tab-closed') void chrome.runtime.sendMessage({ type: 'PIKO_SCAN_INVALIDATED', tabId, scanId: null, reason }).catch(() => {})
    return
  }
  sessions.delete(tabId)
  if (releaseReferences) release(tabId, session)
  void chrome.runtime.sendMessage({ type: 'PIKO_SCAN_INVALIDATED', tabId, scanId: session.scanId, reason }).catch(() => {})
}
function fail(error: ScanError): never { throw error }
export function injectionError(cause: unknown): ScanError {
  const message = cause instanceof Error ? cause.message : ''
  if (/cannot access|missing host permission|permission.*(?:host|page)/i.test(message)) return 'activate-extension'
  if (/(?:could not|cannot|failed to) load (?:file|script)|no such file/i.test(message)) return 'scanner-load-failed'
  return 'injection-failed'
}
export function supportedUrl(raw: string | undefined): URL | null {
  try {
    const url = new URL(raw ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if ((url.hostname === 'chromewebstore.google.com') || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return null
    return url
  } catch { return null }
}
async function inspect(request: InspectRequest): Promise<InspectResponse> {
  let tabId: number | undefined
  let token: string | undefined
  let priorSession: Session | undefined
  let createdSession: Session | undefined
  try {
    const query = request.windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId: request.windowId }
    const [tab] = await chrome.tabs.query(query)
    if (tab?.id === undefined) fail('unavailable-tab')
    tabId = tab.id
    const url = supportedUrl(tab.url)
    // url is optional metadata, not evidence that scripting is denied. Chrome's
    // executeScript permission check below is authoritative. The scanner also
    // checks its own protocol before reading any field metadata.
    if (tab.url && !url) fail('unsupported-page')
    priorSession = sessions.get(tabId)
    // A fresh scan replaces the scope ID, while unchanged DOM nodes may retain
    // their opaque field IDs. Actual staleness and explicit release clear them.
    invalidate(tabId, 'changed', false)
    token = makeId('request')
    pending.set(tabId, token)
    let chromeDocumentId: string | undefined
    try {
      const injection = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: [scannerFile] })
      chromeDocumentId = injection[0]?.documentId
    } catch (cause) { fail(injectionError(cause)) }
    if (!chromeDocumentId) fail('injection-failed')
    if (pending.get(tabId) !== token) fail('stale-scan')
    let inventory: unknown
    try {
      inventory = await chrome.tabs.sendMessage(tabId, { type: 'PIKO_SCAN_DOCUMENT', requestId: request.requestId }, { documentId: chromeDocumentId })
    } catch { fail('scanner-unavailable') }
    if (pending.get(tabId) !== token) fail('stale-scan')
    if (isRecord(inventory) && inventory.error === 'unsupported-page') fail('unsupported-page')
    if (!isScanInventory(inventory) || (url && inventory.origin !== url.origin)) fail('invalid-result')
    const current = inventory as ScanInventory
    const session = { scanId: current.scanId, documentId: current.documentId, chromeDocumentId, inventory: current }
    createdSession = session
    sessions.set(tabId, session)
    const freshness: unknown = await chrome.tabs.sendMessage(tabId, { type: 'PIKO_SCAN_CURRENT', scanId: current.scanId, documentId: current.documentId }, { documentId: chromeDocumentId })
    const [active] = await chrome.tabs.query(query)
    if (!isRecord(freshness) || freshness.current !== true || active?.id !== tabId || pending.get(tabId) !== token || sessions.get(tabId) !== session) fail('stale-scan')
    pending.delete(tabId)
    return { ok: true, requestId: request.requestId, result: { tabId, inventory: current } }
  } catch (cause) {
    const allowed: ScanError[] = ['unsupported-page', 'activate-extension', 'unavailable-tab', 'injection-failed', 'scanner-load-failed', 'scanner-unavailable', 'invalid-result', 'stale-scan']
    const error: ScanError = allowed.includes(cause as ScanError) ? cause as ScanError : 'injection-failed'
    if (tabId !== undefined) {
      if (pending.get(tabId) === token || (createdSession && sessions.get(tabId) === createdSession)) invalidate(tabId, 'changed')
      if (priorSession) release(tabId, priorSession)
    }
    return { ok: false, requestId: request.requestId, error }
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (isConnectionRequest(message) && fromPanel(sender)) {
    void connection.handle(message).then(respond)
    return true
  }
  if (isFillPanelRequest(message) && fromPanel(sender)) {
    void approvals.handle(message).then(respond)
    return true
  }
  if (isInspectRequest(message) && fromPanel(sender)) {
    void inspect(message).then(respond)
    return true
  }
  if (isStopRequest(message) && fromPanel(sender)) {
    approvals.invalidate(message.tabId)
    const session = sessions.get(message.tabId)
    if (session?.scanId === message.scanId) { sessions.delete(message.tabId); release(message.tabId, session) }
    else if (!session) void chrome.tabs.sendMessage(message.tabId, { type: 'PIKO_SCAN_RELEASE', scanId: message.scanId }, { frameId: 0 }).catch(() => {})
    respond({ stopped: true })
    return
  }
  if (isContentStale(message) && sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0) {
    const session = sessions.get(sender.tab.id)
    if (session?.scanId === message.scanId && session.documentId === message.documentId && sender.documentId === session.chromeDocumentId) invalidate(sender.tab.id, 'changed')
    else if (!session && typeof sender.documentId === 'string') void chrome.runtime.sendMessage({ type: 'PIKO_SCAN_INVALIDATED', tabId: sender.tab.id, scanId: message.scanId, reason: 'changed' }).catch(() => {})
  }
})
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' || info.url !== undefined) invalidate(tabId, 'navigation') })
chrome.tabs.onRemoved.addListener((tabId) => invalidate(tabId, 'tab-closed'))
chrome.tabs.onActivated.addListener(({ tabId }) => {
  for (const id of new Set([...sessions.keys(), ...pending.keys()])) if (id !== tabId) invalidate(id, 'tab-switched')
  void chrome.runtime.sendMessage({ type: 'PIKO_SCAN_TAB_ACTIVATED', tabId }).catch(() => {})
})
