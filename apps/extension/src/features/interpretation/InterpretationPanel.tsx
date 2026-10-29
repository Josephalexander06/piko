import { voiceSession } from '../voice-output/voice-session'
import { speechPrompt } from '../voice-output/speech-prompts'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { VoiceControls } from '@/components/assistant/VoiceControls'
import { useConnectionState } from '../local-service/connection.store'
import type { ScanResult } from '../scanner/scanner.types'
import type { InterpretResponse } from './interpretation.generated'
import { interpretationRequest, InterpretationError, type InterpretationErrorCode } from './interpretation.validation'
import { interpretAnswers } from './interpretation.service'

const errors: Record<InterpretationErrorCode, string> = {
  'model-unavailable': 'The configured local Qwen model is unavailable. Check Ollama and the companion model configuration.',
  'interpretation-timeout': 'Local interpretation timed out. Your edited text is preserved; try a shorter answer.',
  'interpretation-busy': 'Another interpretation is running. Try again shortly.',
  'invalid-model-output': 'The model returned invalid output. No proposals were accepted. Edit your answer or retry.',
  'unknown-field-id': 'The model referenced an unknown field. No proposals were accepted.',
  'invalid-option-id': 'The model referenced an unavailable choice. No proposals were accepted.',
  'target-type-mismatch': 'The model proposed an incompatible value type. No proposals were accepted.',
  'duplicate-field-update': 'The model repeated a field. No proposals were accepted.',
  'unsupported-evidence': 'A proposal was not supported by your answer. No proposals were accepted. Use explicit wording or prepare it manually.',
  'proposal-validation-failed': 'A proposal failed field constraints. No proposals were accepted. Edit your answer or prepare it manually.',
  invalid_request: 'The request exceeds the supported field, option or text limits. Use manual answers.',
  body_too_large: 'This request is too large. Use a shorter answer or manual entry.',
  'request-cancelled': 'Interpretation cancelled. Your edited text is preserved.',
  'session-expired': 'The local session expired. Pair the companion again.',
  'service-unavailable': 'The local companion is unavailable. Start it and pair again.',
  'stale-scan': 'The page or scan changed. Inspect again before interpreting.',
  'invalid-response': 'The companion returned an invalid proposal. No proposals were accepted.',
}
export function InterpretationPanel({ scan, active, onProposals }: { scan: ScanResult; active: boolean; onProposals: (result: InterpretResponse | null) => void }) {
  const connection = useConnectionState()
  const [transcript, setTranscript] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<InterpretResponse | null>(null)
  const operation = useRef<AbortController | null>(null)
  const available = active && connection.status === 'paired'
  useEffect(() => () => { operation.current?.abort(); voiceSession.stopSpeech() }, [])
  useEffect(() => { if (!available) { operation.current?.abort(); voiceSession.stopSpeech() } }, [available])
  function edit(text: string) {
    voiceSession.stopSpeech()
    operation.current?.abort(); operation.current = null
    setBusy(false); setTranscript(text); setResult(null); setError(''); onProposals(null)
  }
  async function interpret() {
    const controller = new AbortController()
    operation.current?.abort(); operation.current = controller
    setBusy(true); setError(''); setResult(null); onProposals(null)
    try {
      const value = await interpretAnswers(interpretationRequest(scan, transcript), scan.tabId, controller.signal)
      if (operation.current !== controller || controller.signal.aborted) return
      setResult(value); onProposals(value)
      void voiceSession.speak(speechPrompt(value, scan.inventory.forms.flatMap(form => form.fields)))
    } catch (cause) {
      if (operation.current === controller) setError(errors[cause instanceof InterpretationError ? cause.code : 'service-unavailable'])
    } finally { if (operation.current === controller) { setBusy(false); operation.current = null } }
  }
  return <section aria-label="Local answer interpretation" className="space-y-3 border-t pt-4">
    <h3 className="text-sm font-semibold">Prepare answers with local Qwen</h3>
    <p className="text-xs leading-5 text-muted-foreground">Review your transcription or type an answer. Interpret sends this edited text and eligible field metadata to your paired companion. Review every proposal below; fields remain unselected and nothing is filled automatically.</p>
    <fieldset disabled={!active || busy} className="min-w-0 space-y-3">
      <VoiceControls onAccept={edit} />
      <label htmlFor="interpret-transcript" className="text-xs font-medium">Edited answer for this form</label>
      <Textarea id="interpret-transcript" rows={4} maxLength={4096} value={transcript} onChange={event => edit(event.target.value)} />
      <Button variant="outline" className="min-h-10 w-full" disabled={!available || !transcript.trim()} onClick={() => void interpret()}>Interpret edited answer</Button>
    </fieldset>
    {!available && <p className="text-xs text-muted-foreground">Pair the local companion and keep a current scan to interpret answers. Manual entry remains available.</p>}
    {busy && <><p role="status" className="text-xs">Interpreting locally…</p><Button variant="outline" onClick={() => { operation.current?.abort(); operation.current = null; setBusy(false); setError(errors['request-cancelled']) }}>Cancel interpretation</Button></>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {result && <div aria-label="Interpretation feedback" className="space-y-2 text-xs">
      <p role="status">{result.updates.length} validated proposals · Review and select fields below.</p>
      {result.updates.length > 0 && <details><summary className="cursor-pointer">Source evidence for proposals</summary><ul className="mt-2 space-y-2">{result.updates.map(update => <li key={update.fieldId}><span className="font-medium">{scan.inventory.forms.flatMap(form => form.fields).find(field => field.fieldId === update.fieldId)?.label}: </span><q className="break-words">{update.evidence.quote}</q></li>)}</ul></details>}
      {result.clarifications.length > 0 && <><h4 className="font-semibold">Please clarify</h4><ul className="space-y-2">{result.clarifications.map((item, index) => <li key={index}>{item.question}</li>)}</ul></>}
      {result.missingFields.length > 0 && <><h4 className="font-semibold">Required information still missing</h4><ul className="space-y-2">{result.missingFields.map(item => <li key={item.fieldId}>{item.question}</li>)}</ul></>}
    </div>}
    {(transcript || result) && <Button variant="ghost" onClick={() => edit('')}>Discard interpreted answers</Button>}
  </section>
}
