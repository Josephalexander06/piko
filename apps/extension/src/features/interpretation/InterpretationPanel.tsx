import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { VoiceControls } from '@/components/assistant/VoiceControls'
import { useConnectionState } from '../local-service/connection.store'
import type { WorkflowState } from '../assistant/workflow.types'
import type { AssistantOrchestrator } from '../assistant/assistant.orchestrator'
import { questionQueue, nextQuestion } from '../assistant/question-queue'
import { liveContext } from '../assistant/workflow-guards'

export function InterpretationPanel({ state, controller }: { state: WorkflowState; controller: AssistantOrchestrator }) {
  const connection = useConnectionState()
  const busy = state.stage === 'interpreting'
  const active = liveContext(state) && !['filling', 'approving', 'stale'].includes(state.stage)
  const available = active && connection.status === 'paired'
  const queue = questionQueue(state), current = nextQuestion(state)
  return <section aria-label="Local answer interpretation" className="space-y-3 border-t pt-4">
    <h3 className="text-sm font-semibold">Prepare answers with local Qwen</h3>
    <p className="text-xs leading-5 text-muted-foreground">Review your transcription or type an answer. Interpret sends this edited text and relevant confirmed session facts to your paired companion. Every value remains a proposal until you review and approve it.</p>
    <p role="status" className="text-xs font-medium">Conversation: {state.stage}</p>
    {current && <div aria-label="Current question" className="space-y-2 rounded-lg border p-3 text-xs"><p>{current.question}</p><Button variant="outline" disabled={!active || busy} onClick={() => controller.skip(current.fieldId)}>Skip this question</Button></div>}
    {queue.length > 0 && <details><summary className="cursor-pointer text-xs">Required or ambiguous questions · {queue.length}</summary><ul aria-label="Question queue" className="mt-2 space-y-2 text-xs">{queue.map(item => <li key={item.fieldId}>{item.question}{item.skipped ? ' · Skipped; still unresolved' : ''}</li>)}</ul></details>}
    <VoiceControls onAccept={text => controller.transcript(text)} enabled={active && !busy} resetKey={`${state.session?.sessionId}:${state.scan?.inventory.scanId}:${state.mediaRevision}`} onStageChange={stage => controller.recordingStage(stage)} />
    <label htmlFor="interpret-transcript" className="text-xs font-medium">Edited answer for this form</label>
    <Textarea id="interpret-transcript" rows={4} maxLength={4096} disabled={!active} value={state.transcript} onChange={event => controller.transcript(event.target.value)} />
    <Button variant="outline" className="min-h-10 w-full" disabled={!available || busy || state.stage === 'transcribing' || !state.transcript.trim()} onClick={() => void controller.interpret()}>Interpret edited answer</Button>
    {!available && <p className="text-xs text-muted-foreground">Pair the local companion and keep a current scan to interpret answers. Manual entry remains available.</p>}
    {busy && <><p role="status" className="text-xs">Interpreting locally…</p><Button variant="outline" onClick={() => controller.cancelInterpretation()}>Cancel interpretation</Button></>}
    {state.messages.length > 0 && <div aria-label="Interpretation feedback" className="space-y-2 text-xs"><p role="status">{Object.values(state.drafts).filter(draft => draft.source === 'model').length} validated proposals · Review and select fields below.</p>{Object.keys(state.evidence).length > 0 && <details><summary className="cursor-pointer">Source evidence for proposals</summary><ul>{Object.entries(state.evidence).map(([id, evidence]) => <li key={id}><span className="font-medium">{state.scan?.inventory.forms.flatMap(form => form.fields).find(field => field.fieldId === id)?.label}: </span><q>{evidence.quote}</q></li>)}</ul></details>}{state.clarifications.length > 0 && <><h4 className="font-semibold">Please clarify</h4><ul>{state.clarifications.map((item, index) => <li key={index}>{item.question}</li>)}</ul></>}{queue.length > 0 && <><h4 className="font-semibold">Required information still missing</h4><ul>{queue.map(item => <li key={item.fieldId}>{item.question}</li>)}</ul></>}</div>}
    {state.messages.length > 0 && <details className="text-xs"><summary className="cursor-pointer">Current conversation · temporary</summary><ol aria-label="Live conversation messages" className="mt-2 space-y-2">{state.messages.map((message, index) => <li key={index}><strong>{message.role === 'user' ? 'You' : 'Assistant'}: </strong>{message.text}</li>)}</ol></details>}
    {state.transcript && <Button variant="ghost" disabled={!active} onClick={() => controller.discard()}>Discard interpreted answers</Button>}
  </section>
}
