import { makeId } from '../scanner/scanner.messages'
import { isAudioReply } from './transcription.validation'
import { AUDIO_CHUNK_BYTES, MAX_AUDIO_BYTES, MAX_RECORDING_MS, VOICE_PORT, VoiceInputError } from './transcription.types'
import type { AnswerKind, AudioMessage, AudioReply, Transcript } from './transcription.types'

export async function uploadRecording(audio: Blob, durationMs: number, signal: AbortSignal, answerKind: AnswerKind = 'general'): Promise<Transcript> {
  if (!audio.size) throw new VoiceInputError('empty-audio')
  if (audio.size > MAX_AUDIO_BYTES) throw new VoiceInputError('audio-too-large')
  if (durationMs < 250 || durationMs > MAX_RECORDING_MS) throw new VoiceInputError('audio-too-long')
  const recordingId = makeId('rec')
  const port = chrome.runtime.connect({ name: VOICE_PORT })
  let waiting: { resolve: (reply: AudioReply) => void; reject: (error: unknown) => void } | null = null
  function reject(error: unknown) { waiting?.reject(error); waiting = null }
  function abort() { reject(new VoiceInputError('request-cancelled')); port.disconnect() }
  const disconnected = () => reject(new VoiceInputError('service-unavailable'))
  const listener = (message: unknown) => {
    if (!isAudioReply(message, recordingId)) { reject(new VoiceInputError('invalid-transfer')); return }
    if (message.type === 'error') reject(new VoiceInputError(message.error))
    else { waiting?.resolve(message); waiting = null }
  }
  port.onMessage.addListener(listener); port.onDisconnect.addListener(disconnected)
  signal.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  async function send(message: AudioMessage, timeout: number): Promise<AudioReply> {
    if (signal.aborted) throw new VoiceInputError('request-cancelled')
    return new Promise((resolve, rejectPromise) => {
      waiting = { resolve, reject: rejectPromise }
      timer = setTimeout(() => reject(new VoiceInputError(message.type === 'commit' ? 'transcription-timeout' : 'invalid-transfer')), timeout)
      try { port.postMessage(message) } catch { reject(new VoiceInputError('service-unavailable')) }
    }).finally(() => clearTimeout(timer)) as Promise<AudioReply>
  }
  try {
    const bytes = new Uint8Array(await audio.arrayBuffer())
    const count = Math.ceil(bytes.length / AUDIO_CHUNK_BYTES)
    const initial = await send({ type: 'begin', recordingId, byteLength: bytes.length, chunkCount: count, mimeType: audio.type.split(';')[0].toLowerCase(), durationMs: Math.round(durationMs), answerKind }, 3000)
    if (initial.type !== 'ack' || initial.nextIndex !== 0) throw new VoiceInputError('invalid-transfer')
    for (let index = 0; index < count; index++) {
      const chunk = bytes.subarray(index * AUDIO_CHUNK_BYTES, (index + 1) * AUDIO_CHUNK_BYTES)
      const reply = await send({ type: 'chunk', recordingId, index, data: btoa(String.fromCharCode(...chunk)) }, 3000)
      if (reply.type !== 'ack' || reply.nextIndex !== index + 1) throw new VoiceInputError('invalid-transfer')
    }
    const reply = await send({ type: 'commit', recordingId }, 29_000)
    if (reply.type !== 'result') throw new VoiceInputError('invalid-transfer')
    return reply.result
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    port.onMessage.removeListener(listener); port.onDisconnect.removeListener(disconnected); port.disconnect()
  }
}
