import { useSyncExternalStore } from 'react'
import { initialConnection, type ConnectionState } from './connection.types'

let state = initialConnection
const listeners = new Set<() => void>()
export function publishConnection(next: ConnectionState) { state = next; for (const listener of listeners) listener() }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useConnectionState() { return useSyncExternalStore(subscribe, () => state) }
