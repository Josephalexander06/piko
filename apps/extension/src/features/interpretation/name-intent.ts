const labels = new Set(['name', 'full name', 'first name', 'last name', 'given name', 'surname', 'your name', 'enter your name', 'enter full name', 'enter your full name'])
const emailLabels = new Set(['email', 'email address', 'your email', 'enter your email', 'e-mail', 'e-mail address', 'your email address', 'enter your email address'])

export function cleanLabel(label: string): string {
  return label
    .replace(/(?:[\s:*·•\-_/]|[([]?\s*required(?:\s+question)?\s*[)\]]?)+$/i, '')
    .trim()
}

const normalize = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')

export function isNameField(label: string) {
  return labels.has(normalize(cleanLabel(label)))
}

export function isEmailField(label: string) {
  return emailLabels.has(normalize(cleanLabel(label)))
}
export function nameDescription(label: string): string {
  if (/\b(first|given)\b/i.test(label)) return 'first name'
  if (/\b(last|surname)\b/i.test(label)) return 'last name'
  if (/\bfull\b/i.test(label)) return 'full name'
  return 'name'
}
export function extractDirectAnswer(text: string, field?: { label: string }): string {
  let cleaned = text.trim().replace(/[.!?]+$/, '').trim()
  if (field) {
    const label = cleanLabel(field.label).toLowerCase()
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const prefixRegex = new RegExp(`^(?:(?:(?:my|the)\\s+)?(?:${escaped}\\s+)?(?:is|would be)|i live at|i live in|i am|i['’]m|this is|it is|it's|enter|please enter|put)\\s+`, 'i')
    cleaned = cleaned.replace(prefixRegex, '').trim()
  } else {
    cleaned = cleaned.replace(/^(?:(?:this is|it is|it's|enter|please enter|put)\s+)/i, '').trim()
  }
  cleaned = cleaned.replace(/^(?:please\s+)?(?:use\s+)/i, '').trim()
  return cleaned || text.trim()
}
export function sameNameAnswer(text: string, value: string): boolean {
  const answer = normalize(text).replace(/^(?:(?:my )?(?:full |first |last )?name is|i am|i['’]m)\s+/, '')
  return Boolean(answer) && answer === normalize(value)
}
export function confirmsName(text: string, value: string): boolean {
  const answer = /^yes[,\s]+(.+)$/.exec(normalize(text).replace(/[’]/g, "'"))?.[1]
  if (!answer) return false
  return sameNameAnswer(answer, value) || ["that's my name", "that's my full name", 'that is my name', 'that is my full name', 'that is correct', "that's correct"].includes(answer)
}
export function randomNameRequest(text: string) { return /^(?:please )?(?:(?:use|pick|choose) (?:a )?random (?:full |first |last )?name|generate (?:a )?(?:random )?(?:full |first |last )?name|make up (?:a )?name)(?: for me| for this field)?(?: please)?$/.test(normalize(text)) }
export function nonNameAnswer(text: string): boolean {
  const words = normalize(text).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return /^(?:(?:thank you(?: very much| for watching)?|thanks(?: a lot| for watching)?)(?:\s+|$))+$/.test(words)
}
export function invalidNameValue(text: string) { return /^(?:my (?:full |first |last )?name (?:is|would be)|i am|i['’]m)\b/.test(normalize(text)) || randomNameRequest(text) || nonNameAnswer(text) || ['random name', 'a random name', 'full name'].includes(normalize(text)) }
export function requestedNameValue(label: string, value: string, transcript: string, quote: string) {
  return isNameField(label) && randomNameRequest(transcript) && randomNameRequest(quote) && !invalidNameValue(value) && value.length <= 100 && /^[\p{L}\p{M} .'-]+$/u.test(value) && /\p{L}/u.test(value)
}
