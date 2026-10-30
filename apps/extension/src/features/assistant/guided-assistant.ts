import { AssistantOrchestrator } from './assistant.orchestrator'
import { eligibleFields, validDraft } from './conversation-selectors'
import { summarizeForm } from './form-summary'
import { workflowError } from './workflow-errors'
import type { WorkflowState } from './workflow.types'
import type { ScanField } from '../scanner/scanner.types'
import { voiceSession } from '../voice-output/voice-session'
import { connectionAction } from '../local-service/connection.service'
import { ensureMicrophonePermission } from '../voice-input/microphone-permission'
import { cleanLabel, confirmsName, extractDirectAnswer, invalidNameValue, isEmailField, isNameField, nameDescription, nonNameAnswer, randomNameRequest, sameNameAnswer } from '../interpretation/name-intent'

type Phase = 'idle' | 'starting' | 'summary' | 'answer' | 'interpreting' | 'confirm' | 'filling' | 'complete' | 'ready' | 'stale' | 'error'
export interface GuidedState { phase: Phase; workflow: WorkflowState; fieldId: string | null; message: string; summary: string; heard: string; error: string | null; voice: boolean; turn: number; listen: boolean }
interface Services {
  summarize: typeof summarizeForm; permission: (signal?: AbortSignal) => Promise<void>
  connect: () => Promise<{ transcription: boolean; speech: boolean }>
  speak: (text: string, signal: AbortSignal) => Promise<boolean>
}
export async function speakTurn(text: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const abort = () => voiceSession.stopSpeech()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await voiceSession.speak(text)
    return await new Promise<boolean>(resolve => {
      let unsubscribe = () => {}
      const ended = () => {
        const state = voiceSession.snapshot()
        if (signal.aborted || !['synthesizing', 'playing'].includes(state.output)) { unsubscribe(); signal.removeEventListener('abort', ended); resolve(!signal.aborted && !state.error && state.enabled) }
      }
      unsubscribe = voiceSession.subscribe(ended); signal.addEventListener('abort', ended, { once: true }); ended()
    })
  } finally { signal.removeEventListener('abort', abort) }
}
const defaults: Services = {
  summarize: summarizeForm, permission: ensureMicrophonePermission, speak: speakTurn,
  connect: async () => {
    const reply = await connectionAction({ type: 'PIKO_SERVICE_PAIR' })
    if (!reply.ok || reply.state.status !== 'paired') throw Error('connection')
    return { transcription: reply.state.capabilities?.transcription === 'ready', speech: reply.state.capabilities?.speech_synthesis === 'ready' }
  },
}
export function confirmationIntent(text: string): 'yes' | 'no' | 'correction' {
  const normalized = text.toLowerCase().replace(/[^a-z\s']/g, '').replace(/\s+/g, ' ').trim()
  if (['yes', 'yes please', 'yes correct', 'yes that is correct', 'yes thats correct', "yes that's correct", 'correct', 'confirm', 'that is correct', 'yes fill it', 'yes please fill it', 'fill it', 'yeah', 'yep', 'sure', 'ok', 'okay'].includes(normalized)) return 'yes'
  if (['no', 'no thanks', 'incorrect', 'not correct', 'change it', 'change answer', 'do not fill'].includes(normalized)) return 'no'
  return 'correction'
}
function spoken(text: string) { return Array.from(text.replace(/[\p{C}<>[\]{}]/gu, ' ')).slice(0, 240).join('').trim() }
export function displayAnswer(field: ScanField, workflow: WorkflowState) {
  const draft = workflow.drafts[field.fieldId]
  if (!draft) return ''
  if (field.fieldType === 'select' || field.fieldType === 'radio') return field.options.find(option => option.optionId === draft.text)?.label ?? ''
  return field.fieldType === 'checkbox' ? draft.text === 'true' ? 'Checked' : 'Unchecked' : draft.text
}

/** One guided turn at a time. Every spoken/button confirmation still uses the
 * existing exact review and native one-use authorization engine. */
export class GuidedAssistant {
  readonly workflow: AssistantOrchestrator
  private state: GuidedState
  private listeners = new Set<() => void>()
  private operation = new AbortController()
  private services: Services
  private canListen = false
  private canSpeak = false
  private unsubscribe: () => void
  constructor(workflow = new AssistantOrchestrator({ speak: async () => {} }), services: Partial<Services> = {}) {
    this.workflow = workflow; this.services = { ...defaults, ...services }
    this.state = { phase: 'idle', workflow: workflow.snapshot(), fieldId: null, message: 'Open a form, then start. I’ll ask one question at a time.', summary: '', heard: '', error: null, voice: true, turn: 0, listen: false }
    this.unsubscribe = () => {}
    this.attach()
  }
  attach() {
    this.unsubscribe()
    this.unsubscribe = this.workflow.subscribe(() => {
      const current = this.workflow.snapshot()
      if (current.staleReason || current.stage === 'stale') { this.operation.abort(); voiceSession.stopSpeech(); this.set({ phase: 'stale', listen: false, turn: this.state.turn + 1, message: 'The form changed. Scan it again before continuing.' }) }
      else if (!current.scan && !['idle', 'starting', 'error'].includes(this.state.phase)) { this.operation.abort(); voiceSession.stopSpeech(); this.set({ phase: 'error', listen: false, turn: this.state.turn + 1, error: 'This session ended. Start again to inspect the current form.' }) }
      else if (this.state.phase === 'confirm' && current.stage === 'error' && !current.review) { this.operation.abort(); voiceSession.stopSpeech(); this.set({ phase: 'answer', listen: false, turn: this.state.turn + 1, error: workflowError(current.error ?? 'fill-expired') }) }
      this.set({ workflow: current })
    })
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(change: Partial<GuidedState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener() }
  private renew() { this.operation.abort(); this.operation = new AbortController(); voiceSession.stopSpeech(); this.set({ listen: false, turn: this.state.turn + 1 }); return this.operation.signal }
  fields() { const fields = eligibleFields(this.workflow.snapshot()); return [...fields.filter(field => field.required), ...fields.filter(field => !field.required)] }
  currentField() { return this.fields().find(field => field.fieldId === this.state.fieldId) }
  private async say(message: string, listen = true) {
    const signal = this.operation.signal, turn = this.state.turn
    this.set({ message, listen: false })
    let played = true
    if (this.state.voice && this.canSpeak) played = await this.services.speak(message, signal).catch(() => false)
    if (!signal.aborted && turn === this.state.turn) this.set({ listen: listen && this.state.voice && this.canListen && played })
  }
  async start(voice = true) {
    if (['starting', 'interpreting', 'filling'].includes(this.state.phase)) return
    const signal = this.renew(); this.workflow.clearScan()
    this.set({ phase: 'starting', voice, error: null, heard: '', fieldId: null, summary: '' })
    try {
      const available = await this.services.connect()
      if (signal.aborted) return
      this.canListen = available.transcription; this.canSpeak = available.speech
      if (voice && !available.transcription) throw Error('recognition')
      if (voice) { await this.services.permission(signal); if (signal.aborted) return; voiceSession.enable() } else voiceSession.disable()
      await this.say('Analysing the form.', false)
      if (signal.aborted) return
      await this.workflow.scan()
      if (signal.aborted) return
      const scan = this.workflow.snapshot().scan
      if (!scan) throw Error('scan')
      this.set({ phase: 'summary' })
      let summary: string
      try { summary = (await this.services.summarize(scan, signal)).summary }
      catch { if (signal.aborted) return; summary = `This form has ${this.fields().length} supported fields. We’ll review each answer before filling it.` }
      if (signal.aborted) return
      this.set({ summary }); await this.say(summary, false)
      if (!signal.aborted) await this.next()
    } catch (cause) {
      if (signal.aborted) return
      const code = cause instanceof Error ? cause.message : ''
      this.set({ phase: 'error', error: code === 'recognition' ? 'Whisper is unavailable. Run the voice setup and restart the companion, or use typed answers.' : code === 'microphone-denied' ? 'Microphone permission was not granted. Enable it in the Piko permission tab, or use typed answers.' : code === 'scan' ? workflowError('scan-failed') : 'Start the local companion, then try again.', listen: false })
    }
  }
  private async next() {
    if (this.workflow.snapshot().staleReason) return
    const signal = this.renew(), workflow = this.workflow.snapshot()
    const field = this.fields().find(field => !workflow.verified.includes(field.fieldId) && !workflow.skipped.includes(field.fieldId))
    if (!field) {
      this.set({ phase: 'complete', fieldId: null, heard: '' })
      const missing = this.fields().filter(field => field.required && !workflow.verified.includes(field.fieldId)).length
      await this.say(missing ? `${missing} required answers remain. Review the page and finish them manually.` : 'Your answers have been checked. Review the completed form before submitting it yourself.', false)
      return
    }
    this.workflow.collect(); this.set({ fieldId: field.fieldId, heard: '', error: null })
    if (validDraft(field, this.workflow.snapshot().drafts[field.fieldId])) { await this.prepareConfirmation(); return }
    this.set({ phase: 'answer' })
    const options = field.options.filter(option => !option.disabled).map(option => spoken(option.label)).join(', ')
    const question = isNameField(field.label) ? `${this.fields().indexOf(field) === 0 ? `Let's start with your ${nameDescription(field.label)}. ` : ''}What is your ${nameDescription(field.label)}?` : field.fieldType === 'email' || isEmailField(field.label) ? 'What is your email address?' : `What should I enter for ${spoken(cleanLabel(field.label))}?`
    await this.say(`${question}${options ? options.length <= 350 ? ` Options are ${options}.` : ' Choose from the options shown on the page.' : ''}`)
    if (signal.aborted) return
  }
  typing() { this.renew() }
  async answer(text: string, turn = this.state.turn) {
    if (turn !== this.state.turn || !text.trim() || text.length > 4096 || !['answer', 'confirm'].includes(this.state.phase)) return
    const current = this.currentField()
    if (current && isNameField(current.label) && nonNameAnswer(text)) {
      this.renew()
      this.set({ heard: text, error: null })
      if (this.state.phase === 'confirm') await this.say('Please say yes to continue, or no to change your name.')
      else {
        this.workflow.revise(current.fieldId)
        await this.say(`I couldn't make out your ${nameDescription(current.label)}. Please say it again, or type it below.`)
      }
      return
    }
    if (this.state.phase === 'confirm') {
      const intent = confirmationIntent(text)
      const field = this.currentField(), value = field ? displayAnswer(field, this.workflow.snapshot()) : ''
      this.set({ heard: text })
      if (intent === 'yes' || field && isNameField(field.label) && confirmsName(text, value)) { await this.confirm(); return }
      if (field && isNameField(field.label) && sameNameAnswer(text, value)) {
        this.renew()
        await this.say(`I have your ${nameDescription(field.label)}. Please say yes to continue, or no to change it.`)
        return
      }
      await this.correct(intent === 'no')
      if (intent === 'no') return
    }
    const signal = this.renew()
    if (this.state.fieldId && this.workflow.snapshot().drafts[this.state.fieldId]) this.workflow.revise(this.state.fieldId)
    this.set({ phase: 'interpreting', heard: text, error: null })
    await this.say('Let me check that answer.', false)
    if (signal.aborted) return
    this.workflow.transcript(text); await this.workflow.interpret(this.state.fieldId ?? undefined)
    if (signal.aborted) return
    const field = this.currentField(), workflow = this.workflow.snapshot()
    if (workflow.error) { this.set({ phase: 'answer', error: workflowError(workflow.error) }); return }
    if (field && !validDraft(field, workflow.drafts[field.fieldId])) {
      const direct = extractDirectAnswer(text, field)
      this.workflow.edit(field.fieldId, { text: direct })
    }
    if (!field || !validDraft(field, this.workflow.snapshot().drafts[field.fieldId])) {
      const clarification = workflow.clarifications.find(item => item.targetFieldIds.includes(field?.fieldId ?? ''))
      this.set({ phase: 'answer' }); await this.say(clarification ? spoken(clarification.question) : `I need a clearer answer for ${spoken(cleanLabel(field?.label ?? 'this field'))}. Please try again.`); return
    }
    await this.prepareConfirmation()
  }
  async prepareConfirmation(overwrite = false) {
    const field = this.currentField(); if (!field) return
    const signal = this.renew()
    for (const other of this.fields()) if (this.workflow.snapshot().drafts[other.fieldId]?.selected) this.workflow.edit(other.fieldId, { selected: false })
    this.workflow.edit(field.fieldId, { selected: true, overwrite }); this.set({ phase: 'interpreting' })
    await this.workflow.review()
    if (signal.aborted) return
    if (!this.workflow.snapshot().review) {
      const workflow = this.workflow.snapshot(), reason = workflow.outcome?.results.find(result => result.fieldId === field.fieldId)?.reason
      const error = reason === 'constraint' ? `This page rejected the answer for ${spoken(cleanLabel(field.label))}. Please say it again or type a corrected answer.` : reason === 'existing-value' ? `This field already has a different answer. Clear it on the page, then try again.` : workflowError(workflow.error ?? 'fill-invalid')
      this.set({ phase: 'answer', error }); await this.say(error); return
    }
    this.set({ phase: 'confirm', heard: '', error: null })
    const value = spoken(displayAnswer(field, this.workflow.snapshot()))
    const message = isNameField(field.label) ? randomNameRequest(this.workflow.snapshot().transcript) ? `I suggest the name ${value}.` : `Your ${nameDescription(field.label)} is ${value}.` : field.fieldType === 'email' || isEmailField(field.label) ? `Your email address is ${value}.` : `For ${spoken(cleanLabel(field.label))}, I have ${value}.`
    await this.say(`${message} Shall I continue? Say yes to fill this answer, or no to change it.`)
  }
  async confirm() {
    if (this.state.phase !== 'confirm' || !this.workflow.snapshot().review) return
    const signal = this.renew(); this.set({ phase: 'filling', error: null })
    this.workflow.approveCheckbox(true); await this.workflow.fill()
    if (signal.aborted) return
    const workflow = this.workflow.snapshot()
    if (workflow.error || !workflow.verified.includes(this.state.fieldId!)) { this.set({ phase: 'answer', error: workflowError(workflow.error ?? 'fill-unavailable') }); return }
    await this.next()
  }
  async correct(ask = true) {
    const field = this.currentField(); if (!field || ['filling', 'starting'].includes(this.state.phase)) return
    this.renew(); this.workflow.revise(field.fieldId); this.set({ phase: 'answer', heard: '', error: null })
    if (ask) await this.say(isNameField(field.label) ? `Let's try again. What is your ${nameDescription(field.label)}?` : `What should I enter for ${spoken(cleanLabel(field.label))} instead?`)
  }
  async manual(text: string) {
    const field = this.currentField(); if (!field || !['answer', 'confirm'].includes(this.state.phase)) return
    if (isNameField(field.label) && invalidNameValue(text)) { await this.answer(text); return }
    this.workflow.edit(field.fieldId, { text }); await this.prepareConfirmation()
  }
  cancelAnswer() { this.renew(); this.workflow.cancelInterpretation(); this.set({ phase: 'answer', error: null }) }
  async skip() {
    if (!['answer', 'confirm'].includes(this.state.phase) || !this.state.fieldId) return
    this.renew(); this.workflow.collect(); this.workflow.skip(this.state.fieldId); await this.next()
  }
  async finishReview() {
    if (this.state.phase !== 'complete') return
    this.renew(); this.set({ phase: 'ready' })
    const missing = this.fields().some(field => field.required && !this.workflow.snapshot().verified.includes(field.fieldId))
    await this.say(missing ? 'Review confirmed. Complete the remaining fields on the page before submitting.' : 'Review confirmed. You can submit the form yourself when all page requirements are satisfied.', false)
  }
  async replay() { const message = this.state.message; this.renew(); await this.say(message, ['answer', 'confirm'].includes(this.state.phase)) }
  mute() { this.renew(); this.set({ voice: false }); voiceSession.disable() }
  recording() { this.set({ listen: false }) }
  stale(reason: string) { this.workflow.stale(reason) }
  async end() { this.renew(); this.set({ phase: 'idle' }); voiceSession.reset(); await this.workflow.clearSession(); this.set({ fieldId: null, heard: '', summary: '', message: 'Session ended. Open a form to start again.', error: null }) }
  dispose() { this.operation.abort(); this.unsubscribe(); this.workflow.dispose() }
}
