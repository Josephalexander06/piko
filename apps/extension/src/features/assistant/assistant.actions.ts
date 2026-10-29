import type { ProposedValue } from './assistant.types'

export type AssistantAction =
  | { type: 'LOAD_DEMO_FORM' }
  | { type: 'FINISH_DEMO_INSPECTION' }
  | { type: 'START_CONVERSATION' }
  | { type: 'ADD_DEMO_ANSWER' }
  | { type: 'SET_ANSWER_FIELD'; fieldId: string }
  | { type: 'SET_DRAFT_ANSWER'; value: string }
  | { type: 'ADD_TEXT_ANSWER' }
  | { type: 'ACCEPT_TRANSCRIPT'; text: string }
  | { type: 'UPDATE_PROPOSAL'; fieldId: string; value: ProposedValue['value'] }
  | { type: 'TOGGLE_PROPOSAL'; fieldId: string }
  | { type: 'OPEN_REVIEW' }
  | { type: 'RETURN_TO_CONVERSATION' }
  | { type: 'SIMULATE_APPROVAL' }
  | { type: 'RESET_SESSION' }
  | { type: 'SET_ERROR'; message: string }
