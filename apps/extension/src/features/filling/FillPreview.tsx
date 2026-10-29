import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ScanResult } from '../scanner/scanner.types'
import type { FillBatchResult, FillInstruction, FillPreflight, FillValue } from './fill.types'
import { cancelReview, requestFill } from './fill.service'
import { FillResults } from './FillResults'

interface Draft { selected: boolean; text: string; overwrite: boolean }
interface Review { reviewId: string; expiresAt: number; items: FillInstruction[] }
const errorLabels = { context: 'The scan context was lost or changed. Scan again.', expired: 'This review expired or was already used. Review again.', invalid: 'The batch failed validation. Check the field results.', busy: 'A fill is already running.', unavailable: 'The page could not confirm the outcome. Check it manually before reviewing again.' }
export function FillPreview({ scan, active }: { scan: ScanResult; active: boolean }) {
  const fields = scan.inventory.forms.flatMap((form) => form.fields).filter((field) => field.eligible)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [review, setReview] = useState<Review | null>(null)
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<FillBatchResult | FillPreflight | null>(null)
  const generation = useRef(0)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (!review) return
    const timer = setTimeout(() => { setReview(null); setApproved(false); setError(errorLabels.expired) }, Math.max(0, review.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [review])
  function update(fieldId: string, change: Partial<Draft>) {
    if (review) void cancelReview(review.reviewId)
    generation.current++
    setDrafts((previous) => ({ ...previous, [fieldId]: { ...(previous[fieldId] ?? { selected: false, text: '', overwrite: false }), ...change } }))
    setReview(null); setApproved(false); setOutcome(null); setError('')
  }
  const items: FillInstruction[] = fields.filter((field) => drafts[field.fieldId]?.selected).map((field) => {
    const draft = drafts[field.fieldId]
    const target: FillValue = field.fieldType === 'checkbox' ? { kind: 'checkbox', checked: draft.text === 'true' } : field.fieldType === 'select' || field.fieldType === 'radio' ? { kind: field.fieldType, optionId: draft.text } : { kind: field.fieldType, value: draft.text }
    return { fieldId: field.fieldId, target, overwriteExisting: draft.overwrite }
  })
  const missingChoice = fields.some((field) => drafts[field.fieldId]?.selected && ['select', 'radio', 'checkbox'].includes(field.fieldType) && !drafts[field.fieldId].text)
  async function preflight() {
    const version = ++generation.current
    setBusy(true); setError(''); setReview(null); setApproved(false); setOutcome(null)
    const response = await requestFill({ type: 'PIKO_FILL_REVIEW', tabId: scan.tabId, scanId: scan.inventory.scanId, items }, items)
    if (version !== generation.current || !activeRef.current) { setBusy(false); return }
    if (response.ok && 'reviewId' in response) { setReview({ reviewId: response.reviewId, expiresAt: response.expiresAt, items: structuredClone(items) }); setOutcome(response.preflight) }
    else if (!response.ok) { setError(errorLabels[response.error]); setOutcome(response.preflight ?? null) }
    setBusy(false)
  }
  async function commit() {
    if (!review || !approved || !active || Date.now() >= review.expiresAt) return
    const snapshot = review
    setReview(null); setApproved(false); setBusy(true); setError('')
    const response = await requestFill({ type: 'PIKO_FILL_APPROVE', reviewId: snapshot.reviewId }, snapshot.items)
    if (response.ok && 'result' in response) { setOutcome(response.result); setDrafts({}) }
    else if (!response.ok) { setError(errorLabels[response.error]); setOutcome(response.preflight ?? null) }
    setBusy(false)
  }
  return <section aria-label="Manual form filling" className="space-y-3 border-t pt-4">
    <h3 className="text-sm font-semibold">Prepare manual answers</h3>
    <p className="text-xs leading-5 text-muted-foreground">Enter synthetic test values, include specific fields, then review. Answers stay in temporary extension memory and never go to the companion service. AI is not integrated.</p>
    <fieldset disabled={!active || busy} className="min-w-0 space-y-4">{fields.map((field) => {
      const draft = drafts[field.fieldId] ?? { selected: false, text: '', overwrite: false }
      const id = `proposal-${field.fieldId}`
      return <div key={field.fieldId} className="min-w-0 space-y-2 rounded-lg border p-3 text-xs">
        <label className="flex items-start gap-2"><input type="checkbox" checked={draft.selected} onChange={(event) => update(field.fieldId, { selected: event.target.checked })} aria-label={`Include ${field.label}`} /><span className="break-words font-medium">{field.label}</span></label>
        <label htmlFor={id}>Proposed value for {field.label} · {field.fieldType}</label>
        {field.fieldType === 'checkbox' || field.fieldType === 'select' || field.fieldType === 'radio'
          ? <select id={id} className="min-h-10 w-full min-w-0 rounded-md border bg-white p-2" value={draft.text} onChange={(event) => update(field.fieldId, { text: event.target.value })}><option value="">Choose explicitly…</option>{field.fieldType === 'checkbox' ? <><option value="true">Checked</option><option value="false">Unchecked</option></> : field.options.map((option) => <option key={option.optionId} value={option.optionId} disabled={option.disabled}>{option.label}</option>)}</select>
          : field.fieldType === 'textarea' ? <Textarea id={id} value={draft.text} maxLength={1024} onChange={(event) => update(field.fieldId, { text: event.target.value })} /> : <Input id={id} type="text" autoComplete="off" value={draft.text} maxLength={1024} onChange={(event) => update(field.fieldId, { text: event.target.value })} />}
        <label className="flex items-start gap-2"><input type="checkbox" checked={draft.overwrite} onChange={(event) => update(field.fieldId, { overwrite: event.target.checked })} aria-label={`Allow overwrite for ${field.label}`} /><span>Separately allow replacing an existing answer for this field</span></label>
      </div>
    })}</fieldset>
    <Button variant="outline" className="min-h-10 w-full" disabled={!active || busy || !items.length || missingChoice} onClick={() => void preflight()}>{busy ? 'Checking or filling…' : 'Review selected values'}</Button>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {outcome && <FillResults outcome={outcome} inventory={scan.inventory} />}
    {review && active && <section aria-label="Exact batch approval" className="space-y-3 rounded-lg border border-amber-700/30 p-3 text-xs">
      <h4 className="font-semibold">Review the exact destination and values</h4><p className="break-all">{scan.inventory.origin} · Tab {scan.tabId}</p>
      <ul className="space-y-3">{review.items.map((item) => {
        const form = scan.inventory.forms.find((form) => form.fields.some((field) => field.fieldId === item.fieldId))!
        const field = form.fields.find((field) => field.fieldId === item.fieldId)!
        return <li key={item.fieldId}><p className="font-medium">{form.label} / {field.label}</p><pre className="whitespace-pre-wrap break-all font-mono">{'value' in item.target ? JSON.stringify(item.target.value) : 'checked' in item.target ? item.target.checked ? 'Checked (true)' : 'Unchecked (false)' : `${field.options.find((option) => option.optionId === ('optionId' in item.target ? item.target.optionId : ''))?.label} (${item.target.optionId})`}</pre><p>Overwrite existing: {item.overwriteExisting ? 'Explicitly allowed' : 'Blocked'}</p></li>
      })}</ul>
      <p>Review expires after 60 seconds. Filling triggers the page’s input and change handlers; their side effects cannot reliably be undone. Final state is checked again after 100 ms.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={approved} disabled={busy} onChange={(event) => setApproved(event.target.checked)} /><span>I approve this exact batch and destination.</span></label>
      <Button className="min-h-10 w-full" disabled={!approved || busy} onClick={() => void commit()}>Approve and fill selected fields</Button>
    </section>}
  </section>
}
