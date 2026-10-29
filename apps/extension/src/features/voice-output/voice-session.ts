import { AudioPlayer } from './audio-player'
import { requestSpeech } from './speech.service'
import { isSpeechText } from './speech.validation'
import { SpeechError, type SpeechLease, type VoiceState } from './speech.types'

const initial: VoiceState = { enabled: false, output: 'disabled', recording: false, text: 'What is your full name?', error: null }
export class VoiceCoordinator {
  private state: VoiceState = { ...initial }
  private listeners = new Set<() => void>()
  private microphone: { id: symbol; stop: () => void } | null = null
  private generation = 0
  private controller: AbortController | null = null
  private lease: SpeechLease | null = null
  private blocked = false
  constructor(private readonly synthesize = requestSpeech, private readonly player = new AudioPlayer()) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(change: Partial<VoiceState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener() }
  get retainedBytes() { return this.lease?.bytes.length ?? 0 }
  enable() { if (this.state.enabled) return; this.set({ enabled: true, output: 'idle', error: null }) }
  disable() { this.set({ enabled: false }); this.stopSpeech() }
  stopSpeech() {
    this.generation++; this.controller?.abort(); this.controller = null
    this.player.cancel(); this.lease?.dispose(); this.lease = null; this.blocked = false
    this.set({ output: this.state.enabled ? 'idle' : 'disabled', error: null })
  }
  editText(text: string) { this.stopSpeech(); this.set({ text }) }
  beginRecording(stop: () => void): symbol {
    this.stopSpeech()
    this.microphone?.stop()
    const id = Symbol('microphone')
    this.microphone = { id, stop }; this.set({ recording: true })
    return id
  }
  endRecording(id: symbol) {
    if (this.microphone?.id !== id) return
    this.microphone = null; this.set({ recording: false })
  }
  reset() { this.microphone?.stop(); this.disable(); this.set({ ...initial }) }
  async speak(text: string): Promise<void> {
    if (!this.state.enabled) { this.editText(text); return }
    if (!isSpeechText(text)) { this.stopSpeech(); this.set({ output: 'error', text, error: 'invalid-speech-text' }); return }
    if (this.blocked && this.lease && text === this.state.text) {
      // Invoked synchronously from Play aloud; reuse only the one validated clip
      // after autoplay rejection. No network await consumes the user gesture.
      this.blocked = false
      await this.play(this.generation)
      return
    }
    this.stopSpeech()
    this.microphone?.stop()
    const version = this.generation
    this.controller = new AbortController()
    this.set({ output: 'synthesizing', text, error: null })
    try {
      const lease = await this.synthesize(text, this.controller.signal)
      if (version !== this.generation) { lease.dispose(); return }
      this.lease = lease
      void lease.closed.then(() => {
        if (version === this.generation && this.lease === lease) this.fail(new SpeechError('service-unavailable'))
      })
      await this.play(version)
    } catch (error) { if (version === this.generation) this.fail(error instanceof SpeechError ? error : new SpeechError('speech-synthesis-failed')) }
  }
  private async play(version: number) {
    if (!this.lease || version !== this.generation) return
    try {
      await this.player.play(this.lease.bytes,
        () => { if (version === this.generation) this.stopSpeech() },
        error => { if (version === this.generation) this.fail(error) })
      if (version === this.generation) this.set({ output: 'playing', error: null })
    } catch (error) {
      if (version !== this.generation) return
      if (error instanceof SpeechError && error.code === 'speech-playback-blocked') {
        this.blocked = true
        this.set({ output: 'error', error: error.code })
      } else this.fail(error instanceof SpeechError ? error : new SpeechError('speech-playback-failed'))
    }
  }
  private fail(error: SpeechError) { this.stopSpeech(); this.set({ output: 'error', error: error.code }) }
}
export const voiceSession = new VoiceCoordinator()
