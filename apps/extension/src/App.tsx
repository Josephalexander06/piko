import { sessionAction } from '@/features/assistant/session-facts.service'
import { voiceSession } from '@/features/voice-output/voice-session'
import { VoiceOutputControls } from '@/features/voice-output/VoiceOutputControls'
import { useEffect, useReducer, useRef } from 'react'
import { ArrowLeft, ArrowRight, FlaskConical, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AppShell } from '@/components/layout/AppShell'
import { WorkflowProgress } from '@/components/layout/WorkflowProgress'
import { RuntimeStatus } from '@/components/assistant/RuntimeStatus'
import { ConversationPanel } from '@/components/assistant/ConversationPanel'
import { ProposedValuesList } from '@/components/review/ProposedValuesList'
import { ApprovalSummary } from '@/components/review/ApprovalSummary'
import { assistantReducer, createInitialState, hasValue, selectedProposals } from '@/features/assistant/assistant.reducer'
import type { AssistantStage } from '@/features/assistant/assistant.types'
import { ScannerPanel } from '@/features/scanner/ScannerPanel'

const screenCopy: Record<AssistantStage, { title: string; status: string; description: string }> = {
  idle: { title: 'Local Voice Form Assistant', status: 'Ready to inspect a form', description: 'Inspect a page, prepare answers, and review exactly what you want to fill.' },
  'inspecting-demo': { title: 'Preparing the demo.', status: 'Inspecting synthetic form', description: 'Loading a built-in example. Your current webpage is untouched.' },
  ready: { title: 'A form to practice with.', status: 'Synthetic form ready', description: 'Five sample fields, ready for a private conversation.' },
  conversation: { title: 'Let’s prepare your answers.', status: 'Preparing proposed answers', description: 'Use the sample answer or type fictional details for one field.' },
  review: { title: 'Review before you approve.', status: 'Approval required', description: 'Edit each answer and choose exactly what to include.' },
  'approval-simulated': { title: 'Your selection, confirmed.', status: 'Approval simulated · 0 values inserted', description: 'This is a demonstration of approval, with no website changes.' },
  error: { title: 'The demo needs a reset.', status: 'Demo error', description: 'Your current webpage has not been accessed or changed.' },
}

export default function App() {
  const [state, dispatch] = useReducer(assistantReducer, undefined, createInitialState)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const hasErrors = Object.keys(state.validationErrors).length > 0
  const selected = selectedProposals(state)
  const missing = state.proposals.filter((proposal) => proposal.required && !hasValue(proposal))
  const copy = screenCopy[state.stage]

  useEffect(() => { headingRef.current?.focus() }, [state.stage])
  useEffect(() => { if (hasErrors) errorRef.current?.focus() }, [hasErrors])
  useEffect(() => {
    if (state.stage !== 'inspecting-demo') return
    const timer = window.setTimeout(() => dispatch({ type: 'FINISH_DEMO_INSPECTION' }), 400)
    return () => window.clearTimeout(timer)
  }, [state.stage])

  return <AppShell>
    <RuntimeStatus />
    <VoiceOutputControls />
    {state.stage !== 'idle' && <WorkflowProgress stage={state.stage} />}
    <section aria-labelledby="screen-title" className="space-y-2">
      <p role="status" className="text-[11px] font-medium uppercase tracking-wider text-emerald-800">{copy.status}</p>
      <h1 ref={headingRef} tabIndex={-1} id="screen-title" className="text-2xl font-semibold leading-tight tracking-tight outline-none">{copy.title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{copy.description}</p>
    </section>

    {state.stage === 'idle' && <>
      <ScannerPanel />
      <Card className="rounded-2xl border border-emerald-950/15 bg-white/95 shadow-sm overflow-hidden">
        <CardHeader className="gap-2.5 pb-2">
          <div className="flex items-center justify-between">
            <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-950/10 text-emerald-900">
              <ShieldCheck aria-hidden="true" className="size-4" />
            </div>
            <Badge variant="outline" className="text-[10px] text-emerald-900 border-emerald-950/15">Interactive Sandbox</Badge>
          </div>
          <CardTitle className="text-base text-emerald-950"><h2>Your answers. Your approval.</h2></CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-6 text-muted-foreground">Try a fictional registration form. Have a conversation, prepare answers, then review each value before simulating approval.</p>
          <Button className="primary-action" onClick={() => dispatch({ type: 'LOAD_DEMO_FORM' })}>Load demo form<ArrowRight aria-hidden="true" className="size-4" /></Button>
          <p className="text-[11px] leading-5 text-muted-foreground">No demo loaded. This action uses a built-in fixture and does not inspect your current page.</p>
        </CardContent>
      </Card>
      <details className="text-xs text-muted-foreground px-1"><summary className="cursor-pointer py-2 hover:text-emerald-950 font-medium">Demo scenarios</summary><Button variant="ghost" className="mt-1 w-full text-xs" onClick={() => dispatch({ type: 'SET_ERROR', message: 'This is a simulated preparation error. Reset the demo to try again. No website was accessed.' })}><TriangleAlert aria-hidden="true" className="size-3.5" />Show demo error</Button></details>
    </>}

    {state.stage === 'inspecting-demo' && <div aria-label="Preparing synthetic form" aria-busy="true" className="space-y-3 rounded-2xl border border-emerald-950/15 bg-white p-4 shadow-2xs"><Skeleton className="h-5 w-3/4 motion-reduce:animate-none rounded-lg" /><Skeleton className="h-4 w-1/2 motion-reduce:animate-none rounded-lg" /><Skeleton className="h-24 w-full motion-reduce:animate-none rounded-xl" /></div>}

    {state.form && state.stage !== 'approval-simulated' && <section aria-label="Demo destination" className="space-y-1 rounded-2xl border border-dashed border-emerald-950/25 bg-emerald-50/40 p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-900">Current page · synthetic demo</p>
      <h2 className="text-sm font-semibold text-emerald-950">{state.form.title}</h2>
      <p className="break-all text-xs text-muted-foreground">{state.form.origin}</p>
      <p className="text-[11px] text-muted-foreground">{state.form.fields.length} fields in the demo · No live page inspection</p>
    </section>}

    {state.stage === 'ready' && <>
      <ul aria-label="Synthetic fields" className="divide-y divide-emerald-950/5 rounded-2xl border border-emerald-950/15 bg-white px-4 shadow-2xs">{state.proposals.map((proposal) => <li key={proposal.fieldId} className="flex flex-wrap items-center justify-between gap-1 py-3 text-sm"><span className="font-medium text-emerald-950">{proposal.label}</span><span className="text-[10px] text-muted-foreground font-medium bg-emerald-950/5 px-2 py-0.5 rounded-full">{proposal.required ? 'Required' : 'Optional'} · Not provided</span></li>)}</ul>
      <Button className="primary-action" onClick={() => dispatch({ type: 'START_CONVERSATION' })}>Start conversation<ArrowRight aria-hidden="true" className="size-4" /></Button>
    </>}

    {state.stage === 'conversation' && <ConversationPanel state={state} dispatch={dispatch} />}

    {state.stage === 'review' && <>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-emerald-950">Proposed answers</h2><Badge variant="outline" className="bg-emerald-950/5 border-emerald-950/15 text-emerald-900 text-xs">{selected.length} selected</Badge></div>
      {hasErrors && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3.5 text-sm text-destructive outline-none">Check the highlighted values or exclude those fields before simulating approval.</div>}
      <ProposedValuesList proposals={state.proposals} errors={state.validationErrors} onUpdate={(fieldId, value) => dispatch({ type: 'UPDATE_PROPOSAL', fieldId, value })} onToggle={(fieldId) => dispatch({ type: 'TOGGLE_PROPOSAL', fieldId })} />
      {missing.length > 0 && <Alert role="note" className="border-amber-700/25 bg-amber-50/70 rounded-xl"><TriangleAlert aria-hidden="true" className="size-4 text-amber-700" /><AlertTitle className="font-semibold text-amber-900">Required information is missing</AlertTitle><AlertDescription className="text-xs leading-5 text-amber-950">{missing.map((proposal) => proposal.label).join(', ')} must still be provided or completed manually. Missing answers are excluded, never invented.</AlertDescription></Alert>}
      <ApprovalSummary proposals={selected} origin={state.form!.origin} />
      <Button className="primary-action" disabled={!selected.length} onClick={() => dispatch({ type: 'SIMULATE_APPROVAL' })}>Simulate approval<FlaskConical aria-hidden="true" className="size-4" /></Button>
      <Button variant="outline" className="min-h-11 w-full rounded-xl bg-white hover:bg-emerald-50 text-emerald-950 font-medium" onClick={() => dispatch({ type: 'RETURN_TO_CONVERSATION' })}><ArrowLeft aria-hidden="true" className="size-4" />Back to conversation</Button>
    </>}

    {state.stage === 'approval-simulated' && <>
      <ApprovalSummary proposals={state.approvedProposals} origin={state.form!.origin} simulated />
      <Alert role="note" className="border-amber-700/20 bg-amber-50"><FlaskConical aria-hidden="true" className="size-4" /><AlertTitle>Approved in the demo. Not inserted.</AlertTitle><AlertDescription className="text-xs leading-5">{state.approvedProposals.length} selected {state.approvedProposals.length === 1 ? 'value' : 'values'} in the simulated batch. This is not permission to fill a real form. Reset to start a new review.</AlertDescription></Alert>
    </>}

    {state.stage === 'error' && <Alert variant="destructive"><TriangleAlert aria-hidden="true" className="size-4" /><AlertTitle>Simulated demo error</AlertTitle><AlertDescription>{state.errorMessage}</AlertDescription></Alert>}
    {state.stage !== 'idle' && <Button variant="ghost" className="min-h-10 w-full" onClick={() => { voiceSession.reset(); void sessionAction({ type: 'PIKO_SESSION_CLEAR', sessionId: null }).then(() => dispatch({ type: 'RESET_SESSION' })).catch(() => dispatch({ type: 'SET_ERROR', message: 'Temporary session storage could not be cleared. Reload the extension and use Clear session before continuing.' })) }}><RotateCcw aria-hidden="true" />Reset session</Button>}
  </AppShell>
}
