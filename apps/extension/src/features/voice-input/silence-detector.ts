/** End a spoken turn after speech followed by quiet. The existing 20s hard cap
 * still applies. No audio leaves this in-memory analyser. */
export function watchSilence(stream: MediaStream, stop: () => void, quietMs = 3000): () => void {
  const context = new AudioContext(), source = context.createMediaStreamSource(stream), analyser = context.createAnalyser()
  analyser.fftSize = 2048; source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  let heard = false, lastVoice = performance.now(), voiceSince: number | null = null, finished = false
  void context.resume().catch(() => {})
  const timer = setInterval(() => {
    if (finished) return
    analyser.getFloatTimeDomainData(samples)
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    const now = performance.now()
    // Require sustained sound to start; then retain quieter trailing syllables.
    // A single click cannot arm the end-of-turn timer.
    if (rms >= (heard ? 0.0015 : 0.0025)) {
      voiceSince ??= now
      if (now - voiceSince >= 100) heard = true
      lastVoice = now
    } else {
      voiceSince = null
      if (heard && now - lastVoice >= quietMs) { finished = true; stop() }
    }
  }, 100)
  return () => { finished = true; clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}) }
}
