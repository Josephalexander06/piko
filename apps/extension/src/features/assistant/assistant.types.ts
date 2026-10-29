export type AssistantStage = 'idle' | 'inspecting-demo' | 'ready' | 'conversation' | 'review' | 'approval-simulated' | 'error'
export type ProposalSource = 'user-provided' | 'session-memory' | 'demo'
export type FieldType = 'text' | 'email' | 'tel' | 'number' | 'date' | 'checkbox' | 'select'

export interface DemoField {
  fieldId: string
  label: string
  type: FieldType
  required: boolean
  options?: { value: string; label: string }[]
}

export interface ProposedValue extends DemoField {
  // null is explicitly missing. false is a legitimate checkbox answer.
  value: string | boolean | null
  source: ProposalSource
  selected: boolean
}

export interface AssistantMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
  source: 'demo' | 'user-provided' | 'voice-transcript'
}

export interface DemoForm {
  title: string
  origin: string
  fields: DemoField[]
}

export interface AssistantState {
  stage: AssistantStage
  form: DemoForm | null
  messages: AssistantMessage[]
  proposals: ProposedValue[]
  approvedProposals: ProposedValue[]
  errorMessage: string | null
  validationErrors: Record<string, string>
  draftAnswer: string
  answerFieldId: string
  demoAnswerAdded: boolean
}
