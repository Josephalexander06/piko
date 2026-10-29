import { useSyncExternalStore } from 'react'
import { voiceSession } from './voice-session'
export function useVoiceState() { return useSyncExternalStore(voiceSession.subscribe, voiceSession.snapshot) }
