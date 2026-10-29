import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useConnectionState } from '../local-service/connection.store'
import { voiceSession } from './voice-session'
import { useVoiceState } from './voice.store'
import { isSpeechText } from './speech.validation'
import { MAX_SPEECH_TEXT, type SpeechErrorCode } from './speech.types'

const errors: Record<SpeechErrorCode, string> = {
  'invalid-speech-text': 'Use a short plain-text message without HTML, phoneme markup or control characters.',
  'speech-configuration-invalid': 'The companion speech configuration is invalid.',
  'speech-voice-missing': 'The configured Piper voice or its matching JSON file is missing.',
  'speech-voice-invalid': 'The configured local Piper voice could not load. Check its model and matching JSON file.',
  'speech-unavailable': 'The local voice is unavailable. Check Piper configuration and restart the companion.',
  'speech-busy': 'The local voice is busy. Wait briefly and try again.',
  'speech-timeout': 'Preparing speech took too long. Text is still available.',
  'speech-audio-too-large': 'The generated audio exceeded the limit. Try a shorter message.',
  'invalid-speech-audio': 'The companion returned invalid speech audio. Text is still available.',
  'speech-synthesis-failed': 'Local speech generation failed. Text is still available.',
  'speech-cancelled': 'Speech cancelled.',
  'invalid-speech-transfer': 'Speech audio was incomplete or invalid. Try Play aloud again.',
  'speech-playback-blocked': 'The browser blocked autoplay. Press Play aloud to play the prepared audio.',
  'speech-playback-failed': 'Audio playback failed. Read the message or try Play aloud again.',
  'session-expired': 'The companion session expired. Pair again before playing speech.',
  'service-unavailable': 'The local companion connection closed. Text is still available.',
}
export function VoiceOutputControls() {
  const connection = useConnectionState()
  const state = useVoiceState()
  const available = connection.status === 'paired' && connection.capabilities?.speech_synthesis === 'ready'
  const busy = state.output === 'synthesizing' || state.output === 'playing'
  useEffect(() => { if (!available) voiceSession.disable() }, [available])
  useEffect(() => {
    const reset = () => voiceSession.reset()
    window.addEventListener('pagehide', reset)
    return () => { window.removeEventListener('pagehide', reset); reset() }
  }, [])
  return <section aria-label="Spoken responses" className="space-y-3 rounded-xl border bg-white/60 p-3">
    <h2 className="text-sm font-semibold">Spoken responses</h2>
    <p role="status" className="text-xs">{state.output === 'synthesizing' ? 'Preparing speech…' : state.output === 'playing' ? 'Speaking · microphone inactive' : !available ? 'Voice unavailable · text mode' : state.enabled ? 'Spoken responses enabled' : 'Spoken responses disabled'}</p>
    <label htmlFor="assistant-speech" className="text-xs font-medium">Assistant message to speak</label>
    <Textarea id="assistant-speech" rows={2} value={state.text} maxLength={MAX_SPEECH_TEXT} onChange={event => voiceSession.editText(event.target.value)} />
    <p className="text-[11px] leading-5 text-muted-foreground">Only short application questions and status messages play automatically after you enable speech. Answers and private values are never read automatically. Edited messages play only when you request playback.</p>
    {!state.enabled ? <Button variant="outline" className="min-h-10 w-full" disabled={!available || !isSpeechText(state.text)} onClick={() => { voiceSession.enable(); void voiceSession.speak(state.text) }}>Enable spoken responses and test voice</Button>
      : <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!available || !isSpeechText(state.text) || busy} onClick={() => void voiceSession.speak(state.text)}>Play aloud</Button><Button variant="ghost" onClick={() => voiceSession.disable()}>Disable spoken responses</Button></div>}
    {(busy || state.output === 'error') && <Button variant="outline" className="min-h-10 w-full" onClick={() => voiceSession.stopSpeech()}>Stop speech</Button>}
    {!available && connection.capabilities?.speech_synthesis_detail && <p className="text-xs text-muted-foreground">{errors[connection.capabilities.speech_synthesis_detail]}</p>}
    {state.error && <p role="alert" className="text-xs text-destructive">{errors[state.error]}</p>}
  </section>
}
