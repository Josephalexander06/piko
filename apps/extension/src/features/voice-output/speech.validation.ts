import { hasKeys, isOpaqueId, isRecord } from '../scanner/scanner.messages'
import { MAX_SPEECH_BYTES, MAX_SPEECH_SECONDS, MAX_SPEECH_TEXT, SPEECH_CHUNK_BYTES, speechErrors, type SpeechReply, type SpeechRequest } from './speech.types'

export function isSpeechText(text: unknown): text is string {
  return typeof text === 'string' && text.length <= MAX_SPEECH_TEXT && text.trim().length > 0 && !Array.from(text.normalize('NFKC')).some(char => '<>{}[]'.includes(char)) && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(text)
}
export function isSpeechRequest(value: unknown): value is SpeechRequest {
  if (!isRecord(value) || !isOpaqueId(value.speechId)) return false
  if (value.type === 'synthesize') return hasKeys(value, ['type', 'speechId', 'text']) && isSpeechText(value.text)
  if (value.type === 'release') return hasKeys(value, ['type', 'speechId'])
  return value.type === 'ack' && hasKeys(value, ['type', 'speechId', 'nextIndex']) && Number.isSafeInteger(value.nextIndex) && Number(value.nextIndex) >= 0 && Number(value.nextIndex) <= Math.ceil(MAX_SPEECH_BYTES / SPEECH_CHUNK_BYTES)
}
export function isSpeechReply(value: unknown, id: string): value is SpeechReply {
  if (!isRecord(value) || value.speechId !== id) return false
  if (value.type === 'complete') return hasKeys(value, ['type', 'speechId'])
  if (value.type === 'error') return hasKeys(value, ['type', 'speechId', 'error']) && (speechErrors as readonly unknown[]).includes(value.error)
  if (value.type === 'begin') return hasKeys(value, ['type', 'speechId', 'mimeType', 'byteLength', 'chunkCount']) && value.mimeType === 'audio/wav' && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) > 44 && Number(value.byteLength) <= MAX_SPEECH_BYTES && value.chunkCount === Math.ceil(Number(value.byteLength) / SPEECH_CHUNK_BYTES)
  return value.type === 'chunk' && hasKeys(value, ['type', 'speechId', 'index', 'data']) && Number.isSafeInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < Math.ceil(MAX_SPEECH_BYTES / SPEECH_CHUNK_BYTES) && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= Math.ceil(SPEECH_CHUNK_BYTES / 3) * 4
}
export function isSpeechWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= 44 || bytes.byteLength > MAX_SPEECH_BYTES) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) return false
  let offset = 12, format = false, data = false, rate = 0, dataBytes = 0, count = 0
  while (offset + 8 <= bytes.length) {
    if (++count > 32) return false
    const size = view.getUint32(offset + 4, true)
    const begin = offset + 8, end = begin + size
    if (end > bytes.length) return false
    const name = tag(offset)
    if (name === 'fmt ') {
      if (format || size < 16 || view.getUint16(begin, true) !== 1 || view.getUint16(begin + 2, true) !== 1 || view.getUint16(begin + 14, true) !== 16 || view.getUint16(begin + 12, true) !== 2) return false
      rate = view.getUint32(begin + 4, true)
      if (rate < 8000 || rate > 48000 || view.getUint32(begin + 8, true) !== rate * 2) return false
      format = true
    } else if (name === 'data') {
      if (data || !size || size % 2) return false
      data = true; dataBytes = size
    }
    offset = end + size % 2
  }
  return format && data && offset === bytes.length && dataBytes <= rate * 2 * MAX_SPEECH_SECONDS
}
