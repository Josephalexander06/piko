export const MAX_AUDIO_BYTES = 8 * 1024 * 1024
export const MAX_RECORDING_MS = 20_000
export const AUDIO_CHUNK_BYTES = 48 * 1024
export const VOICE_PORT = 'PIKO_VOICE_V1'
export const answerKinds = ['general', 'name', 'email', 'tel', 'number', 'date', 'confirmation'] as const
export type AnswerKind = typeof answerKinds[number]
export const voiceErrors = ['microphone-denied', 'microphone-missing', 'recording-failed', 'empty-audio', 'unsupported-audio', 'audio-too-large', 'audio-too-long', 'invalid-audio', 'conversion-failed', 'transcription-timeout', 'model-unavailable', 'transcription-failed', 'transcription-busy', 'invalid-transfer', 'request-cancelled', 'service-unavailable', 'session-expired', 'invalid-response'] as const
export type VoiceErrorCode = typeof voiceErrors[number]
export class VoiceInputError extends Error { constructor(readonly code: VoiceErrorCode) { super(code) } }
export interface Transcript { status: 'ok' | 'no-speech'; text: string; language: 'en'; durationMs: number; processingMs: number }
export type AudioMessage =
  | { type: 'begin'; recordingId: string; mimeType: string; byteLength: number; durationMs: number; chunkCount: number; answerKind?: AnswerKind }
  | { type: 'chunk'; recordingId: string; index: number; data: string }
  | { type: 'commit'; recordingId: string }
export type AudioReply =
  | { type: 'ack'; recordingId: string; nextIndex: number }
  | { type: 'result'; recordingId: string; result: Transcript }
  | { type: 'error'; recordingId: string; error: VoiceErrorCode }
