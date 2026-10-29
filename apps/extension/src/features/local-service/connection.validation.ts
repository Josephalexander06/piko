import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import type { Capabilities, ConnectionRequest, ConnectionState } from './connection.types'

export function isConnectionRequest(value: unknown): value is ConnectionRequest {
  if (!isRecord(value) || !isOpaqueId(value.requestId)) return false
  if (value.type === 'PIKO_SERVICE_PAIR') return hasKeys(value, ['type', 'requestId', 'code']) && typeof value.code === 'string' && /^[a-f0-9]{16}$/.test(value.code)
  return hasKeys(value, ['type', 'requestId']) && typeof value.type === 'string' && ['PIKO_SERVICE_STATUS', 'PIKO_SERVICE_HEALTH', 'PIKO_SERVICE_PING', 'PIKO_SERVICE_CAPABILITIES', 'PIKO_SERVICE_DISCONNECT'].includes(value.type)
}
export function isCapabilities(value: unknown): value is Capabilities {
  return isRecord(value) && hasKeys(value, ['protocol_version', 'inference', 'transcription', 'speech_synthesis']) && value.protocol_version === 1 && value.inference === 'not_integrated' && value.transcription === 'not_integrated' && value.speech_synthesis === 'not_integrated'
}
export function isConnectionState(value: unknown): value is ConnectionState {
  return isRecord(value) && hasKeys(value, ['status', 'checkedAt', 'expiresAt', 'capabilities', 'error', 'disconnectPending']) && typeof value.status === 'string' && ['disconnected', 'available', 'paired', 'expired', 'unavailable'].includes(value.status) && (value.checkedAt === null || Number.isSafeInteger(value.checkedAt) && Number(value.checkedAt) >= 0) && (value.expiresAt === null || Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0) && (value.capabilities === null || isCapabilities(value.capabilities)) && (value.error === null || typeof value.error === 'string' && ['service-unavailable', 'timeout', 'pairing-rejected', 'rate-limited', 'session-expired', 'invalid-response', 'unsupported-protocol', 'unsupported-origin', 'disconnect-unconfirmed', 'busy', 'storage-unavailable'].includes(value.error)) && typeof value.disconnectPending === 'boolean' && (value.status !== 'paired' || value.checkedAt !== null && value.expiresAt !== null && !value.disconnectPending && value.error === null)
}
