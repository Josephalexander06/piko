import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { WorkflowState } from '../assistant/workflow.types'
import type { AssistantOrchestrator } from '../assistant/assistant.orchestrator'
import { eligibleFields, emptyDraft, selectedItems, validDraft, unverifiedRequired } from '../assistant/conversation-selectors'
import { factValue } from '../assistant/session-facts.validation'
import { liveContext } from '../assistant/workflow-guards'
import { questionQueue } from '../assistant/question-queue'
import { FillResults } from './FillResults'
import { InterpretationPanel } from '../interpretation/InterpretationPanel'
import { workflowError } from '../assistant/workflow-errors'



export function FillPreview({ state, controller }: { state: WorkflowState; controller: AssistantOrchestrator }) {
  const scan = state.scan!
  const fields = eligibleFields(state), items = selectedItems(state), review = state.review
  const busy = state.stage === 'filling' || state.stage === 'approving'
  const active = liveContext(state)
  const invalid = fields.some(field => state.drafts[field.fieldId]?.selected && !validDraft(field, state.drafts[field.fieldId]))
  const unresolved = questionQueue(state)
  return <section aria-label="Manual form filling" className="space-y-3 border-t pt-4">
    <InterpretationPanel state={state} controller={controller} />
    <h3 className="text-sm font-semibold">Prepare manual answers</h3>
    <p className="text-xs leading-5 text-muted-foreground">Edit proposals or enter answers manually, include specific fields, then review. Manual edits are protected from later model answers. Remembering answers is a separate choice at approval.</p>
    {state.session?.facts.length ? <p className="text-xs">{state.session.facts.length} confirmed session facts available. Reused values are unselected proposals.</p> : null}
    <fieldset disabled={!active || busy} className="min-w-0 space-y-4">{fields.map(field => {
      const draft = state.drafts[field.fieldId] ?? emptyDraft(), id = `proposal-${field.fieldId}`
      return <div key={field.fieldId} className="min-w-0 space-y-2 rounded-lg border p-3 text-xs">
        <label className="flex items-start gap-2"><input type="checkbox" checked={draft.selected} onChange={event => controller.edit(field.fieldId, { selected: event.target.checked })} aria-label={`Include ${field.label}`} /><span className="break-words font-medium">{field.label}</span></label>
        {draft.source === 'session' && <p>From confirmed session memory · Review before reuse</p>}
        {draft.protected && <p>Manual choice · Protected from model replacement</p>}
        <label htmlFor={id}>Proposed value for {field.label} · {field.fieldType}</label>
        {['checkbox', 'select', 'radio'].includes(field.fieldType)
          ? <select id={id} className="min-h-10 w-full min-w-0 rounded-md border bg-white p-2" value={draft.text} onChange={event => controller.edit(field.fieldId, { text: event.target.value })}><option value="">Choose explicitly…</option>{field.fieldType === 'checkbox' ? <><option value="true">Checked</option><option value="false">Unchecked</option></> : field.options.map(option => <option key={option.optionId} value={option.optionId} disabled={option.disabled}>{option.label}</option>)}</select>
          : field.fieldType === 'textarea' ? <Textarea id={id} value={draft.text} maxLength={1024} onChange={event => controller.edit(field.fieldId, { text: event.target.value })} /> : <Input id={id} type="text" autoComplete="off" value={draft.text} maxLength={1024} onChange={event => controller.edit(field.fieldId, { text: event.target.value })} />}
        <label className="flex items-start gap-2"><input type="checkbox" checked={draft.overwrite} onChange={event => controller.edit(field.fieldId, { overwrite: event.target.checked })} aria-label={`Allow overwrite for ${field.label}`} /><span>Separately allow replacing an existing answer for this field</span></label>
      </div>
    })}</fieldset>
    <Button variant="outline" className="min-h-10 w-full" disabled={!active || busy || state.stage === 'interpreting' || !items.length || invalid} onClick={() => void controller.review()}>{busy ? 'Checking or filling…' : 'Review selected values'}</Button>
    {state.error && <><p role="alert" className="text-xs text-destructive">{workflowError(state.error)}</p>{active && <Button variant="outline" onClick={() => controller.recover()}>Continue with typed or manual answers</Button>}</>}
    {unresolved.length > 0 && <p className="text-xs text-amber-900">{unresolved.length} required or ambiguous fields remain unresolved, including skipped questions. You may review a partial batch or finish manually.</p>}
    {state.outcome && <FillResults outcome={state.outcome} inventory={scan.inventory} />}
    {state.stage === 'results' && <><p className="text-xs">{unverifiedRequired(state).length} required fields have not been verified on this scan. Submission remains manual. Verified results apply to this scan only. New or changed fields require another inspection and approval.</p><Button variant="outline" disabled={!active} onClick={() => controller.collect()}>Continue conversation</Button></>}
    {review && active && state.stage === 'review' && <section aria-label="Exact batch approval" className="space-y-3 rounded-lg border border-amber-700/30 p-3 text-xs">
      <h4 className="font-semibold">Review the exact destination and values</h4><p className="break-all">{scan.inventory.origin} · Tab {scan.tabId}</p>
      <ul className="space-y-3">{review.items.map(item => {
        const form = scan.inventory.forms.find(form => form.fields.some(field => field.fieldId === item.fieldId))!, field = form.fields.find(field => field.fieldId === item.fieldId)!
        return <li key={item.fieldId}><p className="font-medium">{form.label} / {field.label}</p><pre className="whitespace-pre-wrap break-all font-mono">{'value' in item.target ? JSON.stringify(item.target.value) : 'checked' in item.target ? item.target.checked ? 'Checked (true)' : 'Unchecked (false)' : field.options.find(option => option.optionId === ('optionId' in item.target ? item.target.optionId : ''))?.label}</pre><p>Overwrite existing: {item.overwriteExisting ? 'Explicitly allowed' : 'Blocked'}</p></li>
      })}</ul>
      <p>Review expires after 60 seconds. Filling triggers the page’s input and change handlers; their side effects cannot reliably be undone.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={state.remember} onChange={event => controller.rememberCheckbox(event.target.checked)} /><span>Remember selected answers for this session</span></label>
      <p>Separate opt-in: only confirmed, successfully verified eligible answers with supported meanings are retained for this origin, for up to 30 minutes. {review.items.filter(item => { const field = fields.find(field => field.fieldId === item.fieldId); return field && factValue(field, item) }).length} selected answers can be remembered. Passwords, codes, credentials, consent and unknown field meanings are never remembered.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={state.approved} onChange={event => controller.approveCheckbox(event.target.checked)} /><span>I approve this exact batch and destination.</span></label>
      <Button className="min-h-10 w-full" disabled={!state.approved || busy} onClick={() => void controller.fill()}>Approve and fill selected fields</Button>
    </section>}
  </section>
}
