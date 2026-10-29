import type { AssistantAction } from './assistant.actions'
import type { AssistantState, ProposedValue } from './assistant.types'
import { demoAnswer, demoForm, demoQuestion, demoValues } from './mock-data'

export function createInitialState(): AssistantState {
  return {
    stage: 'idle', form: null, messages: [], proposals: [], approvedProposals: [],
    errorMessage: null, validationErrors: {}, draftAnswer: '', answerFieldId: '', demoAnswerAdded: false,
  }
}

export function hasValue(proposal: ProposedValue): boolean {
  return proposal.value !== null && (typeof proposal.value === 'boolean' || proposal.value.trim().length > 0)
}

export function selectedProposals(state: AssistantState): ProposedValue[] {
  return state.proposals.filter((proposal) => proposal.selected && hasValue(proposal))
}

export function valueLabel(proposal: ProposedValue): string {
  if (!hasValue(proposal)) return 'Not provided'
  if (typeof proposal.value === 'boolean') return proposal.value ? 'Yes' : 'No'
  return proposal.options?.find((option) => option.value === proposal.value)?.label ?? String(proposal.value)
}

export function proposalError(proposal: ProposedValue): string | null {
  if (!hasValue(proposal)) return 'Enter an answer or leave this field excluded.'
  if (proposal.type === 'checkbox') return typeof proposal.value === 'boolean' ? null : 'Choose yes or no.'
  if (typeof proposal.value !== 'string') return 'Enter a text answer.'
  if (proposal.value.length > 1024) return 'Use 1,024 characters or fewer.'
  if (proposal.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proposal.value)) return 'Enter a valid email address.'
  if (proposal.type === 'number' && !Number.isFinite(Number(proposal.value))) return 'Enter a valid number.'
  if (proposal.type === 'date') {
    const date = new Date(`${proposal.value}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proposal.value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== proposal.value) return 'Enter a valid date.'
  }
  if (proposal.type === 'select' && !proposal.options?.some((option) => option.value === proposal.value)) return 'Choose an available option.'
  return null
}

function clarification(proposals: ProposedValue[]): string {
  const missing = proposals.filter((proposal) => proposal.required && !hasValue(proposal))
  return missing.length
    ? `Still missing: ${missing.map((proposal) => proposal.label).join(', ')}. Please provide ${missing[0].label.toLowerCase()}, or leave it for manual completion. No answer has been invented.`
    : 'The required sample answers are available. Review your proposals before simulating approval.'
}

export function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case 'LOAD_DEMO_FORM':
      return state.stage === 'idle' ? { ...createInitialState(), stage: 'inspecting-demo' } : state
    case 'FINISH_DEMO_INSPECTION':
      return state.stage === 'inspecting-demo' ? {
        ...state, stage: 'ready',
        form: { ...demoForm, fields: demoForm.fields.map((field) => ({ ...field, options: field.options?.map((option) => ({ ...option })) })) },
        proposals: demoForm.fields.map((field) => ({ ...field, value: null, source: 'demo', selected: false })),
        answerFieldId: demoForm.fields[0].fieldId,
      } : state
    case 'START_CONVERSATION':
      return state.stage === 'ready' ? { ...state, stage: 'conversation', messages: [{ id: 'question-1', role: 'assistant', content: demoQuestion, source: 'demo' }] } : state
    case 'ADD_DEMO_ANSWER': {
      if (state.stage !== 'conversation' || state.demoAnswerAdded) return state
      const proposals = state.proposals.map((proposal) => !hasValue(proposal) && demoValues[proposal.fieldId] !== undefined
        ? { ...proposal, value: demoValues[proposal.fieldId], selected: true, source: 'demo' as const }
        : proposal)
      return {
        ...state, proposals, demoAnswerAdded: true, validationErrors: {},
        messages: [...state.messages,
          { id: `message-${state.messages.length}`, role: 'user', content: demoAnswer, source: 'demo' },
          { id: `message-${state.messages.length + 1}`, role: 'assistant', content: clarification(proposals), source: 'demo' }],
        answerFieldId: proposals.find((proposal) => proposal.required && !hasValue(proposal))?.fieldId ?? state.answerFieldId,
      }
    }
    case 'SET_ANSWER_FIELD':
      return state.stage === 'conversation' && state.proposals.some((proposal) => proposal.fieldId === action.fieldId)
        ? { ...state, answerFieldId: action.fieldId, draftAnswer: '', validationErrors: {} } : state
    case 'ACCEPT_TRANSCRIPT': {
      if (state.stage !== 'conversation' || typeof action.text !== 'string' || !action.text.trim() || action.text.length > 4096) return state
      return { ...state, messages: [...state.messages,
        { id: `message-${state.messages.length}`, role: 'user', content: action.text.trim(), source: 'voice-transcript' },
        { id: `message-${state.messages.length + 1}`, role: 'assistant', content: 'Transcript added to this synthetic demo. For local interpretation, reset the demo and inspect a real form. No fields were changed.', source: 'demo' }],
      }
    }
    case 'SET_DRAFT_ANSWER':
      return state.stage === 'conversation' ? { ...state, draftAnswer: action.value.slice(0, 1024), validationErrors: {} } : state
    case 'ADD_TEXT_ANSWER': {
      if (state.stage !== 'conversation') return state
      const current = state.proposals.find((proposal) => proposal.fieldId === state.answerFieldId)
      if (!current || current.type === 'checkbox') return state
      const next = { ...current, value: state.draftAnswer.trim(), source: 'user-provided' as const, selected: true }
      const error = proposalError(next)
      if (error) return { ...state, validationErrors: { answer: error } }
      const proposals = state.proposals.map((proposal) => proposal.fieldId === current.fieldId ? next : proposal)
      return {
        ...state, proposals, draftAnswer: '', validationErrors: {},
        messages: [...state.messages,
          { id: `message-${state.messages.length}`, role: 'user', content: `${current.label}: ${next.value}`, source: 'user-provided' },
          { id: `message-${state.messages.length + 1}`, role: 'assistant', content: clarification(proposals), source: 'demo' }],
      }
    }
    case 'UPDATE_PROPOSAL':
      if (state.stage !== 'review' || !state.proposals.some((proposal) => proposal.fieldId === action.fieldId)) return state
      return {
        ...state, validationErrors: {},
        proposals: state.proposals.map((proposal) => {
          if (proposal.fieldId !== action.fieldId) return proposal
          const updated: ProposedValue = { ...proposal, value: action.value, source: 'user-provided' }
          // Clearing an answer also excludes it, so a disabled missing-value
          // checkbox can never conceal a still-selected empty proposal.
          return { ...updated, selected: hasValue(updated) && proposal.selected }
        }),
      }
    case 'TOGGLE_PROPOSAL':
      return state.stage === 'review' ? {
        ...state, proposals: state.proposals.map((proposal) => proposal.fieldId === action.fieldId
          ? { ...proposal, selected: hasValue(proposal) ? !proposal.selected : false } : proposal), validationErrors: {},
      } : state
    case 'OPEN_REVIEW':
      return state.stage === 'conversation' && state.proposals.some(hasValue)
        ? { ...state, stage: 'review', draftAnswer: '', validationErrors: {} } : state
    case 'RETURN_TO_CONVERSATION':
      return state.stage === 'review' ? { ...state, stage: 'conversation', validationErrors: {} } : state
    case 'SIMULATE_APPROVAL': {
      if (state.stage !== 'review') return state
      const selected = state.proposals.filter((proposal) => proposal.selected)
      if (!selected.length) return state
      const errors: Record<string, string> = {}
      for (const proposal of selected) {
        const error = proposalError(proposal)
        if (error) errors[proposal.fieldId] = error
      }
      if (Object.keys(errors).length) return { ...state, validationErrors: errors }
      return {
        ...state, stage: 'approval-simulated', validationErrors: {}, draftAnswer: '',
        approvedProposals: selected.map((proposal) => ({ ...proposal })),
      }
    }
    case 'RESET_SESSION':
      return createInitialState()
    case 'SET_ERROR':
      return { ...createInitialState(), stage: 'error', errorMessage: action.message }
  }
}

// The synthetic demo above has no authority over live pages. This is the sole
// reducer used by the active-page conversation orchestrator.
export { workflowReducer, initialWorkflow } from './workflow.reducer'
