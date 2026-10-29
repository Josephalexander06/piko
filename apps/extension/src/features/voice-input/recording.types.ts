import type { VoiceErrorCode } from './transcription.types'

export type RecordingStage = 'idle' | 'requesting-permission' | 'recording' | 'processing' | 'transcript-ready' | 'no-speech' | 'error'
export interface RecordingState { stage: RecordingStage; elapsedMs: number; transcript: string; error: VoiceErrorCode | null }
export const initialRecording: RecordingState = { stage: 'idle', elapsedMs: 0, transcript: '', error: null }
