import { makeId } from '../scanner/scanner.messages'
import { isSpeechReply, isSpeechText, isSpeechWav } from './speech.validation'
import { SPEECH_CHUNK_BYTES, SPEECH_PORT, SpeechError, type SpeechLease, type SpeechRequest } from './speech.types'

export function requestSpeech(text: string, signal: AbortSignal): Promise<SpeechLease> {
  if (!isSpeechText(text)) return Promise.reject(new SpeechError('invalid-speech-text'))
  if (signal.aborted) return Promise.reject(new SpeechError('speech-cancelled'))
  const speechId = makeId('speech')
  const port = chrome.runtime.connect({ name: SPEECH_PORT })
  let chunks: Uint8Array[] = [], bytes = 0, expected = 0, count = 0, began = false, completed = false, disposed = false
  let timer: ReturnType<typeof setTimeout>
  let closeLease: () => void = () => {}
  const closed = new Promise<void>(resolve => { closeLease = resolve })
  let rejectRequest: (error: Error) => void = () => {}
  function dispose() {
    if (disposed) return
    disposed = true; clearTimeout(timer); chunks = []; bytes = 0
    signal.removeEventListener('abort', abort)
    port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected)
    try { port.postMessage({ type: 'release', speechId }); port.disconnect() } catch { /* Already closed. */ }
    closeLease()
  }
  function fail(error: SpeechError) { rejectRequest(error); dispose() }
  function abort() { fail(new SpeechError('speech-cancelled')) }
  function disconnected() { fail(new SpeechError('service-unavailable')) }
  function send(value: SpeechRequest) { try { port.postMessage(value) } catch { fail(new SpeechError('service-unavailable')) } }
  let resolveRequest: (result: SpeechLease) => void = () => {}
  function receive(value: unknown) {
    if (disposed) return
    if (!isSpeechReply(value, speechId)) { fail(new SpeechError('invalid-speech-transfer')); return }
    if (value.type === 'error') { fail(new SpeechError(value.error)); return }
    if (completed) { fail(new SpeechError('invalid-speech-transfer')); return }
    clearTimeout(timer); timer = setTimeout(() => fail(new SpeechError('invalid-speech-transfer')), 3000)
    if (value.type === 'begin') {
      if (began) { fail(new SpeechError('invalid-speech-transfer')); return }
      began = true; expected = value.byteLength; count = value.chunkCount
      send({ type: 'ack', speechId, nextIndex: 0 }); return
    }
    if (!began) { fail(new SpeechError('invalid-speech-transfer')); return }
    if (value.type === 'chunk') {
      if (value.index !== chunks.length || value.index >= count) { fail(new SpeechError('invalid-speech-transfer')); return }
      try {
        const decoded = atob(value.data)
        if (btoa(decoded) !== value.data || decoded.length !== Math.min(SPEECH_CHUNK_BYTES, expected - bytes)) throw Error()
        chunks.push(Uint8Array.from(decoded, char => char.charCodeAt(0))); bytes += decoded.length
      } catch { fail(new SpeechError('invalid-speech-transfer')); return }
      send({ type: 'ack', speechId, nextIndex: chunks.length }); return
    }
    if (bytes !== expected || chunks.length !== count) { fail(new SpeechError('invalid-speech-transfer')); return }
    const audio = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length }
    chunks = []; bytes = 0
    if (!isSpeechWav(audio)) { fail(new SpeechError('invalid-speech-audio')); return }
    completed = true; clearTimeout(timer)
    // Keep only the port lease until playback ends; no worker-side audio buffer.
    resolveRequest({ bytes: audio, dispose, closed })
  }
  const result = new Promise<SpeechLease>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject })
  port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnected)
  signal.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => fail(new SpeechError('speech-timeout')), 34_000)
  send({ type: 'synthesize', speechId, text })
  return result
}
