import { useCallback, useEffect, useRef, useState } from 'react'
import { PlugZap } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PairingPanel } from './PairingPanel'
import { connectionAction, type ConnectionAction } from './connection.service'
import { type ConnectionError } from './connection.types'
import { publishConnection, useConnectionState } from './connection.store'

const errors: Record<ConnectionError, string> = {
  'service-unavailable': 'The companion service is unavailable. Start it on 127.0.0.1:8765, then check again.',
  timeout: 'The local service request timed out. Check that the service is responding.',
  'pairing-rejected': 'Pairing was rejected. The code may be incorrect, expired, or consumed. Restart the service for a fresh code.',
  'rate-limited': 'Too many pairing attempts. Wait 60 seconds before trying again.',
  'session-expired': 'The session expired or the service restarted. Pair again with a fresh terminal code.',
  'invalid-response': 'The service returned an invalid response. Check the companion version before retrying.',
  'unsupported-protocol': 'The service uses an unsupported protocol version. Update the extension and companion together.',
  'unsupported-origin': 'The service rejected this extension origin. Restart the companion and pair this extension again.',
  'disconnect-unconfirmed': 'Disconnected locally; server revocation is not confirmed. Keep this browser session open and retry disconnect, or restart the companion. The saved credential is restricted to revocation.',
  busy: 'A connection operation is already running. Wait for it to finish.',
  'storage-unavailable': 'Temporary extension session storage is unavailable. Reload the extension before pairing.',
}
const titles = { disconnected: 'Local runtime not connected', available: 'Companion available · not paired', paired: 'Companion paired', expired: 'Companion session expired', unavailable: 'Companion unavailable' }
export function RuntimeStatus() {
  const state = useConnectionState()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const act = useCallback(async (action: ConnectionAction) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const response = await connectionAction(action)
    if (mounted.current) { publishConnection(response.state); setBusy(false) }
    inFlight.current = false
  }, [])
  useEffect(() => {
    mounted.current = true
    void act({ type: 'PIKO_SERVICE_STATUS' })
    return () => { mounted.current = false }
  }, [act])
  useEffect(() => {
    if (state.status !== 'paired') return
    // Only authenticated sessions are rechecked. No automatic pairing attempts.
    const timer = setInterval(() => void act({ type: 'PIKO_SERVICE_STATUS' }), 30_000)
    const expiry = setTimeout(() => void act({ type: 'PIKO_SERVICE_STATUS' }), Math.max(0, (state.expiresAt ?? 0) - Date.now()))
    return () => { clearInterval(timer); clearTimeout(expiry) }
  }, [state.status, state.expiresAt, act])
  return <section aria-label="Local companion connection" className="space-y-3">
    <Alert role="status" aria-live="polite" className="border-emerald-950/10 bg-emerald-950/5">
      <PlugZap aria-hidden="true" className="size-4" />
      <AlertTitle>{titles[state.status]}</AlertTitle>
      <AlertDescription className="text-xs leading-5">{busy ? 'Checking local connection…' : 'Local voice input requires a paired, configured companion. Answer interpretation and speech playback are not integrated.'}</AlertDescription>
    </Alert>
    {state.error && <p role="alert" className="text-xs leading-5 text-destructive">{errors[state.error]}</p>}
    <PairingPanel state={state} busy={busy} act={act} />
  </section>
}
