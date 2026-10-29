import { hasKeys, isRecord, makeId } from '../scanner/scanner.messages'
import { initialConnection } from './connection.types'
import type { ConnectionRequest, ConnectionResponse } from './connection.types'
import { isConnectionState } from './connection.validation'

export type ConnectionAction = ConnectionRequest extends infer Request ? Request extends { requestId: string } ? Omit<Request, 'requestId'> : never : never
export async function connectionAction(action: ConnectionAction): Promise<ConnectionResponse> {
  const request: ConnectionRequest = { ...action, requestId: makeId('request') }
  try {
    const response: unknown = await chrome.runtime.sendMessage(request)
    if (isRecord(response) && hasKeys(response, ['requestId', 'ok', 'state']) && response.requestId === request.requestId && typeof response.ok === 'boolean' && isConnectionState(response.state)) return response as unknown as ConnectionResponse
    return { requestId: request.requestId, ok: false, state: { ...initialConnection, error: 'invalid-response' } }
  } catch { return { requestId: request.requestId, ok: false, state: { ...initialConnection, status: 'unavailable', error: 'service-unavailable' } } }
}
