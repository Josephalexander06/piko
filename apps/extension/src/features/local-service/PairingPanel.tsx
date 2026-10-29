import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ConnectionState } from './connection.types'
import type { ConnectionAction } from './connection.service'

export function PairingPanel({ state, busy, act }: { state: ConnectionState; busy: boolean; act: (action: ConnectionAction) => Promise<void> }) {
  const [code, setCode] = useState('')
  const canPair = !busy && !state.disconnectPending && state.status !== 'paired' && /^[a-f0-9]{16}$/.test(code)
  return <details className="rounded-lg border bg-white/60 p-3 text-xs">
    <summary className="cursor-pointer font-medium">Local service connection</summary>
    <div className="mt-3 space-y-3">
      <p>Service: <code>127.0.0.1:8765</code>. Start the companion service and copy its 16-character pairing code. Codes expire after 5 minutes and work once.</p>
      <Button variant="outline" className="min-h-10 w-full" disabled={busy} onClick={() => void act({ type: 'PIKO_SERVICE_HEALTH' })}>{state.disconnectPending ? 'Retry pending disconnect' : 'Check service'}</Button>
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault()
        if (!canPair) return
        const submitted = code
        setCode('')
        void act({ type: 'PIKO_SERVICE_PAIR', code: submitted })
      }}>
        <label htmlFor="pairing-code">Temporary pairing code</label>
        <Input id="pairing-code" type="password" autoComplete="off" spellCheck={false} maxLength={16} value={code} disabled={busy || state.status === 'paired' || state.disconnectPending} onChange={(event) => setCode(event.target.value.trim())} />
        <Button className="min-h-10 w-full" type="submit" disabled={!canPair}>Pair extension</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || state.status !== 'paired'} onClick={() => void act({ type: 'PIKO_SERVICE_PING' })}>Authenticated ping</Button>
        <Button variant="outline" disabled={busy || state.status !== 'paired'} onClick={() => void act({ type: 'PIKO_SERVICE_CAPABILITIES' })}>Check capabilities</Button>
      </div>
      <Button variant="outline" className="min-h-10 w-full" disabled={busy} onClick={() => { setCode(''); void act({ type: 'PIKO_SERVICE_DISCONNECT' }) }}>Disconnect service</Button>
      {state.capabilities && <ul aria-label="Local service capabilities" className="space-y-1"><li>Inference: not integrated</li><li>Transcription: not integrated</li><li>Speech synthesis: not integrated</li></ul>}
      {state.checkedAt !== null && <p>Last verified: {new Date(state.checkedAt).toLocaleTimeString()}</p>}
      {state.expiresAt !== null && <p>Session expires: {new Date(state.expiresAt).toLocaleString()}</p>}
      <p>Sessions expire after 12 hours and are invalidated by a service restart. Restart the service to obtain a new code after disconnecting. Form answers, page metadata, and audio are never sent.</p>
    </div>
  </details>
}
