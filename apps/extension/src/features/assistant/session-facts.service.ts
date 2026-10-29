import { hasKeys, isRecord, makeId } from '../scanner/scanner.messages'
import { isSessionSnapshot } from './session-facts.validation'
import type { SessionRequest, SessionSnapshot } from './session-facts.types'
import type { ScanResult } from '../scanner/scanner.types'

type Action = Omit<Extract<SessionRequest, { type: 'PIKO_SESSION_STATUS' }>, 'requestId'> | Omit<Extract<SessionRequest, { type: 'PIKO_SESSION_ENSURE' }>, 'requestId'> | Omit<Extract<SessionRequest, { type: 'PIKO_SESSION_CLEAR' }>, 'requestId'>
export async function sessionAction(action: Action): Promise<SessionSnapshot | null> {
  const request = { ...action, requestId: makeId('request') }
  let response: unknown
  try { response = await chrome.runtime.sendMessage(request) } catch { throw new Error('session-storage-unavailable') }
  if (!isRecord(response) || response.requestId !== request.requestId) throw new Error('session-storage-unavailable')
  if (response.ok === false && typeof response.error === 'string' && ['session-expired', 'stale-scan', 'session-storage-unavailable'].includes(response.error)) throw new Error(response.error)
  if (response.ok !== true || !hasKeys(response, ['ok', 'requestId', 'session']) || response.session !== null && !isSessionSnapshot(response.session)) throw new Error('session-storage-unavailable')
  return response.session as SessionSnapshot | null
}
export const ensureSession = (scan: ScanResult) => sessionAction({ type: 'PIKO_SESSION_ENSURE', tabId: scan.tabId, scanId: scan.inventory.scanId })
