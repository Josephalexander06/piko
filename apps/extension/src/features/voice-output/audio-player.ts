import { isSpeechWav } from './speech.validation'
import { MAX_SPEECH_SECONDS, SpeechError } from './speech.types'

interface PlayerDependencies {
  createAudio: (url: string) => HTMLAudioElement
  createURL: (blob: Blob) => string
  revokeURL: (url: string) => void
}
const defaults: PlayerDependencies = {
  createAudio: url => new Audio(url), createURL: blob => URL.createObjectURL(blob), revokeURL: url => URL.revokeObjectURL(url),
}
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private deps: PlayerDependencies
  constructor(dependencies: Partial<PlayerDependencies> = {}) { this.deps = { ...defaults, ...dependencies } }
  get active() { return this.audio !== null }
  cancel() {
    this.generation++; clearTimeout(this.timer)
    const audio = this.audio; this.audio = null
    if (audio) {
      audio.onended = null; audio.onerror = null
      audio.pause(); audio.removeAttribute('src'); audio.load()
    }
    if (this.url) { this.deps.revokeURL(this.url); this.url = null }
  }
  async play(bytes: Uint8Array, ended: () => void, failed: (error: SpeechError) => void): Promise<void> {
    this.cancel()
    if (!isSpeechWav(bytes)) throw new SpeechError('invalid-speech-audio')
    const version = this.generation
    this.url = this.deps.createURL(new Blob([bytes.slice().buffer], { type: 'audio/wav' }))
    const audio = this.deps.createAudio(this.url)
    this.audio = audio
    audio.onended = () => { if (version === this.generation) { this.cancel(); ended() } }
    audio.onerror = () => { if (version === this.generation) { this.cancel(); failed(new SpeechError('speech-playback-failed')) } }
    this.timer = setTimeout(() => { if (version === this.generation) { this.cancel(); failed(new SpeechError('speech-playback-failed')) } }, (MAX_SPEECH_SECONDS + 5) * 1000)
    try {
      await audio.play()
      if (version !== this.generation) throw new SpeechError('speech-cancelled')
    } catch (error) {
      if (version !== this.generation) throw new SpeechError('speech-cancelled')
      this.cancel()
      throw new SpeechError(error instanceof Error && error.name === 'NotAllowedError' ? 'speech-playback-blocked' : 'speech-playback-failed')
    }
  }
}
