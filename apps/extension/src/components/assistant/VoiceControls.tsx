import { useVoiceState } from '@/features/voice-output/voice.store'
import { useEffect, useState } from 'react'
import { Mic, MicOff, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RecordingController } from '@/features/voice-input/recording.controller'
import { uploadRecording } from '@/features/voice-input/audio-transport'
import { initialRecording } from '@/features/voice-input/recording.types'
import { useConnectionState } from '@/features/local-service/connection.store'
import type { VoiceErrorCode } from '@/features/voice-input/transcription.types'
import { RecordingIndicator } from './RecordingIndicator'
import { TranscriptEditor } from './TranscriptEditor'

const messages: Record<VoiceErrorCode, string> = {
  'microphone-denied': "Microphone access is blocked. Check your browser's permissions.", 'microphone-missing': 'No available microphone was detected.',
  'recording-failed': 'Recording failed. Check your microphone and try again.', 'empty-audio': 'No audio was captured. Try again.',
  'unsupported-audio': 'This recording format is unsupported. Try another supported browser.', 'audio-too-large': 'The recording is too large. Try a shorter recording.',
  'audio-too-long': 'The recording exceeds 20 seconds. Try a shorter recording.', 'invalid-audio': 'The recording could not be processed. Try again.',
  'conversion-failed': 'The recording could not be processed. Try again.', 'transcription-timeout': 'Transcription took too long. Try a shorter recording.',
  'model-unavailable': 'Local speech recognition is not configured.', 'transcription-failed': 'Local transcription failed. Please try again.',
  'transcription-busy': 'Another recording is being processed. Please try again shortly.', 'invalid-transfer': 'The recording transfer was incomplete. Please try again.',
  'request-cancelled': 'Recording discarded.', 'service-unavailable': 'The local assistant service is not running.',
  'session-expired': 'The local session expired. Pair the companion again.', 'invalid-response': 'The companion returned an invalid transcription response.',
}
export function VoiceControls({ onAccept, enabled = true, resetKey, onStageChange }: { onAccept: (text: string) => void; enabled?: boolean; resetKey?: string; onStageChange?: (stage: string) => void }) {
  const connection = useConnectionState()
  const voice = useVoiceState()
  const speaking = voice.output === 'synthesizing' || voice.output === 'playing'
  const [state, setState] = useState(initialRecording)
  const [controller] = useState(() => new RecordingController(setState, uploadRecording))
  const available = enabled && connection.status === 'paired' && connection.capabilities?.transcription === 'ready'
  useEffect(() => () => controller.reset(false), [controller])
  useEffect(() => { controller.reset() }, [controller, resetKey])
  useEffect(() => { onStageChange?.(state.stage) }, [state.stage, onStageChange])
  useEffect(() => { if (!available) controller.reset() }, [available, controller])
  return <div className="space-y-1.5">
    {state.stage === 'recording' ? <><RecordingIndicator elapsedMs={state.elapsedMs} /><Button variant="outline" className="min-h-10 w-full" onClick={() => controller.stop()}><Square aria-hidden="true" />Stop recording</Button></>
      : state.stage === 'requesting-permission' || state.stage === 'processing' ? <><p role="status" className="text-xs">{state.stage === 'processing' ? 'Transcribing locally… Microphone stopped.' : 'Requesting microphone permission…'}</p><Button variant="outline" onClick={() => controller.reset()}>Cancel voice input</Button></>
      : state.stage === 'transcript-ready' ? <TranscriptEditor key={state.transcript} transcript={state.transcript} accept={text => { onAccept(text); controller.reset() }} discard={() => controller.reset()} retry={() => void controller.start()} />
      : <><Button disabled={!available || speaking} variant="outline" className="min-h-10 w-full" aria-describedby="microphone-note" onClick={() => void controller.start()}>{available ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}{available ? 'Start voice recording' : 'Microphone unavailable'}</Button>
        {state.stage === 'error' && state.error && <p role="alert" className="text-xs text-destructive">{messages[state.error]}</p>}
        {state.stage === 'no-speech' && <p role="status" className="text-xs">No clear speech was detected. Please try again.</p>}</>}
    {speaking && available && <Button variant="outline" className="min-h-10 w-full" onClick={() => void controller.start()}>Stop speech and record</Button>}
    {(state.stage === 'recording' || state.stage === 'requesting-permission') && <Button variant="ghost" onClick={() => controller.reset()}>Discard recording</Button>}
    <p id="microphone-note" className="text-center text-[11px] leading-5 text-muted-foreground">{available ? 'Press Start, speak for up to 20 seconds, then Stop. Audio is uploaded only to your paired local companion.' : 'Pair a companion with local speech recognition configured, or use typed answers.'}</p>
  </div>
}
