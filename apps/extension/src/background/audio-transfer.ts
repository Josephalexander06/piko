import { isAudioMessage } from '../features/voice-input/transcription.validation'
import { AUDIO_CHUNK_BYTES, VoiceInputError } from '../features/voice-input/transcription.types'
import type { AnswerKind, AudioMessage, AudioReply, Transcript } from '../features/voice-input/transcription.types'

/** One recording per trusted extension port; never persistent session storage. */
export class AudioTransfer {
  private begin: Extract<AudioMessage, { type: 'begin' }> | null = null
  private chunks: Uint8Array[] = []
  private bytes = 0
  private controller = new AbortController()
  private done = false
  private processing = false
  private timer: ReturnType<typeof setTimeout>
  constructor(private readonly reply: (reply: AudioReply) => void, private readonly transcribe: (audio: Blob, signal: AbortSignal, answerKind: AnswerKind) => Promise<Transcript>, private readonly release: () => void, timeout = 15000) {
    this.timer = setTimeout(() => this.fail('invalid-transfer'), timeout)
  }
  get retainedBytes() { return this.bytes }
  dispose() {
    if (this.done) return
    this.done = true; this.controller.abort(); clearTimeout(this.timer)
    this.chunks = []; this.bytes = 0; this.release()
  }
  private fail(error: VoiceInputError['code']) {
    if (this.done) return
    try { this.reply({ type: 'error', recordingId: this.begin?.recordingId ?? '', error }) } finally { this.dispose() }
  }
  async receive(message: unknown) {
    if (this.done) return
    if (!isAudioMessage(message) || this.processing) { this.fail('invalid-transfer'); return }
    if (message.type === 'begin') {
      if (this.begin) { this.fail('invalid-transfer'); return }
      this.begin = message
      this.reply({ type: 'ack', recordingId: message.recordingId, nextIndex: 0 })
      return
    }
    if (!this.begin || message.recordingId !== this.begin.recordingId) { this.fail('invalid-transfer'); return }
    if (message.type === 'chunk') {
      if (message.index !== this.chunks.length || message.index >= this.begin.chunkCount) { this.fail('invalid-transfer'); return }
      try {
        const decoded = atob(message.data)
        if (btoa(decoded) !== message.data) throw new Error()
        const expected = Math.min(AUDIO_CHUNK_BYTES, this.begin.byteLength - this.bytes)
        if (decoded.length !== expected) throw new Error()
        this.chunks.push(Uint8Array.from(decoded, character => character.charCodeAt(0)))
        this.bytes += decoded.length
      } catch { this.fail('invalid-transfer'); return }
      this.reply({ type: 'ack', recordingId: message.recordingId, nextIndex: this.chunks.length })
      return
    }
    if (this.bytes !== this.begin.byteLength || this.chunks.length !== this.begin.chunkCount) { this.fail('invalid-transfer'); return }
    this.processing = true
    clearTimeout(this.timer)
    try {
      const audio = new Blob(this.chunks as BlobPart[], { type: this.begin.mimeType })
      this.chunks = []; this.bytes = 0
      const result = await this.transcribe(audio, this.controller.signal, this.begin.answerKind ?? 'general')
      if (!this.done) this.reply({ type: 'result', recordingId: message.recordingId, result })
    } catch (error) {
      if (!this.done) this.reply({ type: 'error', recordingId: message.recordingId, error: error instanceof VoiceInputError ? error.code : 'transcription-failed' })
    } finally { this.dispose() }
  }
}
