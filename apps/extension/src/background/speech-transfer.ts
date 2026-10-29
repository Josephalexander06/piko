import { isSpeechRequest, isSpeechWav } from '../features/voice-output/speech.validation'
import { MAX_SPEECH_SECONDS, SPEECH_CHUNK_BYTES, SpeechError, type SpeechReply } from '../features/voice-output/speech.types'

/** Acknowledged, bounded output transfer; the port owns one playback lease. */
export class SpeechTransfer {
  private id = ''
  private phase: 'initial' | 'fetching' | 'sending' | 'leased' | 'closed' = 'initial'
  private bytes: Uint8Array | null = null
  private nextIndex = 0
  private controller = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  constructor(private readonly reply: (value: SpeechReply) => void, private readonly synthesize: (text: string, signal: AbortSignal) => Promise<Uint8Array>, private readonly release: () => void, private readonly closePort: () => void = () => {}, private readonly timeoutMs = 3000) {
    this.timer = setTimeout(() => this.fail('invalid-speech-transfer'), timeoutMs)
  }
  get retainedBytes() { return this.bytes?.length ?? 0 }
  private deadline(ms = this.timeoutMs) { clearTimeout(this.timer); this.timer = setTimeout(() => this.fail('invalid-speech-transfer'), ms) }
  dispose() {
    if (this.phase === 'closed') return
    this.phase = 'closed'; this.controller.abort(); clearTimeout(this.timer); this.bytes = null
    this.release(); this.closePort()
  }
  private fail(error: SpeechError['code']) {
    if (this.phase === 'closed') return
    try { this.reply({ type: 'error', speechId: this.id, error }) } finally { this.dispose() }
  }
  async receive(value: unknown) {
    if (this.phase === 'closed') return
    if (!isSpeechRequest(value)) { this.fail('invalid-speech-transfer'); return }
    if (this.phase === 'initial') {
      if (value.type !== 'synthesize') { this.fail('invalid-speech-transfer'); return }
      this.id = value.speechId; this.phase = 'fetching'; this.deadline(35_000)
      try {
        const bytes = await this.synthesize(value.text, this.controller.signal)
        if (this.controller.signal.aborted) return
        if (!isSpeechWav(bytes)) throw new SpeechError('invalid-speech-audio')
        this.bytes = bytes; this.phase = 'sending'; this.deadline()
        this.reply({ type: 'begin', speechId: this.id, mimeType: 'audio/wav', byteLength: bytes.length, chunkCount: Math.ceil(bytes.length / SPEECH_CHUNK_BYTES) })
      } catch (error) { this.fail(error instanceof SpeechError ? error.code : 'speech-synthesis-failed') }
      return
    }
    if (value.speechId !== this.id) { this.fail('invalid-speech-transfer'); return }
    if (value.type === 'release') { this.dispose(); return }
    if (this.phase !== 'sending' || value.type !== 'ack' || value.nextIndex !== this.nextIndex || !this.bytes) { this.fail('invalid-speech-transfer'); return }
    const offset = this.nextIndex * SPEECH_CHUNK_BYTES
    if (offset >= this.bytes.length) {
      this.bytes = null; this.phase = 'leased'; this.deadline(MAX_SPEECH_SECONDS * 1000 + 5000)
      this.reply({ type: 'complete', speechId: this.id }); return
    }
    const chunk = this.bytes.subarray(offset, offset + SPEECH_CHUNK_BYTES)
    const index = this.nextIndex++
    this.deadline()
    this.reply({ type: 'chunk', speechId: this.id, index, data: btoa(String.fromCharCode(...chunk)) })
  }
}
