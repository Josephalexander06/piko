export const SPEECH_PORT = 'PIKO_SPEECH_V1'
export const MAX_SPEECH_TEXT = 800
export const MAX_SPEECH_BYTES = 8 * 1024 * 1024
export const SPEECH_CHUNK_BYTES = 48 * 1024
export const MAX_SPEECH_SECONDS = 120
export const speechErrors = ['invalid-speech-text', 'speech-configuration-invalid', 'speech-voice-missing', 'speech-voice-invalid', 'speech-unavailable', 'speech-busy', 'speech-timeout', 'speech-audio-too-large', 'invalid-speech-audio', 'speech-synthesis-failed', 'speech-cancelled', 'invalid-speech-transfer', 'speech-playback-blocked', 'speech-playback-failed', 'session-expired', 'service-unavailable'] as const
export type SpeechErrorCode = typeof speechErrors[number]
export class SpeechError extends Error { constructor(readonly code: SpeechErrorCode) { super(code) } }
export type VoiceOutputState = 'disabled' | 'idle' | 'synthesizing' | 'playing' | 'error'
export interface VoiceState { enabled: boolean; output: VoiceOutputState; recording: boolean; text: string; error: SpeechErrorCode | null }
export interface SpeechLease { bytes: Uint8Array; dispose: () => void; closed: Promise<void> }
export type SpeechRequest =
  | { type: 'synthesize'; speechId: string; text: string }
  | { type: 'ack'; speechId: string; nextIndex: number }
  | { type: 'release'; speechId: string }
export type SpeechReply =
  | { type: 'begin'; speechId: string; mimeType: 'audio/wav'; byteLength: number; chunkCount: number }
  | { type: 'chunk'; speechId: string; index: number; data: string }
  | { type: 'complete'; speechId: string }
  | { type: 'error'; speechId: string; error: SpeechErrorCode }
