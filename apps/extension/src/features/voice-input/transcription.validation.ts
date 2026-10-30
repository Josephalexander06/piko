import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import { AUDIO_CHUNK_BYTES, MAX_AUDIO_BYTES, MAX_RECORDING_MS, answerKinds, voiceErrors } from './transcription.types'
import type { AudioMessage, AudioReply, Transcript } from './transcription.types'

export const supportedAudioTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav']
export function isTranscript(value: unknown): value is Transcript {
  return isRecord(value) && hasKeys(value, ['status', 'text', 'language', 'durationMs', 'processingMs']) && (value.status === 'ok' || value.status === 'no-speech') && typeof value.text === 'string' && value.text.length <= 4096 && [...value.text].every(character => character.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(character)) && (value.status === 'ok' ? value.text.trim().length > 0 : value.text === '') && value.language === 'en' && Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0 && Number(value.durationMs) <= MAX_RECORDING_MS && Number.isSafeInteger(value.processingMs) && Number(value.processingMs) >= 0 && Number(value.processingMs) <= 120_000
}
export function isAudioMessage(value: unknown): value is AudioMessage {
  if (!isRecord(value) || !isOpaqueId(value.recordingId) || !value.recordingId.startsWith('rec_')) return false
  if (value.type === 'commit') return hasKeys(value, ['type', 'recordingId'])
  if (value.type === 'chunk') return hasKeys(value, ['type', 'recordingId', 'index', 'data']) && Number.isSafeInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < Math.ceil(MAX_AUDIO_BYTES / AUDIO_CHUNK_BYTES) && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= AUDIO_CHUNK_BYTES * 4 / 3 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
  return value.type === 'begin' && hasKeys(value, ['type', 'recordingId', 'mimeType', 'byteLength', 'durationMs', 'chunkCount', ...('answerKind' in value ? ['answerKind'] : [])]) && (!('answerKind' in value) || (answerKinds as readonly unknown[]).includes(value.answerKind)) && typeof value.mimeType === 'string' && supportedAudioTypes.includes(value.mimeType) && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) > 0 && Number(value.byteLength) <= MAX_AUDIO_BYTES && Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 250 && Number(value.durationMs) <= MAX_RECORDING_MS && value.chunkCount === Math.ceil(Number(value.byteLength) / AUDIO_CHUNK_BYTES)
}
export function isAudioReply(value: unknown, recordingId: string): value is AudioReply {
  if (!isRecord(value) || value.recordingId !== recordingId) return false
  if (value.type === 'result') return hasKeys(value, ['type', 'recordingId', 'result']) && isTranscript(value.result)
  if (value.type === 'ack') return hasKeys(value, ['type', 'recordingId', 'nextIndex']) && Number.isSafeInteger(value.nextIndex) && Number(value.nextIndex) >= 0
  return value.type === 'error' && hasKeys(value, ['type', 'recordingId', 'error']) && typeof value.error === 'string' && (voiceErrors as readonly string[]).includes(value.error)
}
