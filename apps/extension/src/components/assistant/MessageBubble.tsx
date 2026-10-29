import type { AssistantMessage } from '@/features/assistant/assistant.types'

export function MessageBubble({ message }: { message: AssistantMessage }) {
  return <li className={`min-w-0 space-y-1.5 rounded-xl p-3 ${message.role === 'user' ? 'ml-5 bg-emerald-950/5' : 'mr-3 border bg-white'}`}>
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{message.role === 'assistant' ? 'Assistant · scripted demo' : message.source === 'demo' ? 'You · sample answer' : message.source === 'voice-transcript' ? 'You · reviewed voice transcript' : 'You · typed answer'}</p>
    <p className="break-words text-sm leading-6 [overflow-wrap:anywhere]">{message.content}</p>
  </li>
}
