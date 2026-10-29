import { useEffect, useState, useSyncExternalStore } from 'react'
import { isActivated, isInvalidated, isRecord } from '../scanner/scanner.messages'
import { AssistantOrchestrator } from './assistant.orchestrator'

export function useAssistant() {
  const [controller] = useState(() => new AssistantOrchestrator())
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => {
    void controller.restore()
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return
      const current = controller.snapshot()
      if (isActivated(message) && current.scan && current.scan.tabId !== message.tabId) controller.stale('tab-switched')
      if (isInvalidated(message) && current.scan?.tabId === message.tabId && (message.scanId === null || message.scanId === current.scan.inventory.scanId)) controller.stale(message.reason)
      if (isRecord(message) && message.type === 'PIKO_SESSION_CLEARED' && (message.sessionId === null || message.sessionId === current.session?.sessionId)) void controller.refreshSession()
      if (isRecord(message) && message.type === 'PIKO_SESSION_CHANGED' && message.sessionId === current.session?.sessionId && message.version !== current.session?.version) void controller.refreshSession()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => { chrome.runtime.onMessage.removeListener(listener); controller.dispose() }
  }, [controller])
  useEffect(() => {
    if (!state.session) return
    const timer = setTimeout(() => void controller.refreshSession(), Math.max(0, state.session.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [controller, state.session])
  return { state, controller }
}
