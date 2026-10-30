const labels = new Set(['name', 'full name', 'first name', 'last name', 'given name', 'surname', 'your name', 'enter your name', 'enter full name', 'enter your full name'])
const normalize = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
export function isNameField(label: string) { return labels.has(normalize(label).replace(/\s*(?::|\*|\(required\))+\s*$/, '').trim()) }
export function randomNameRequest(text: string) { return /^(?:please )?(?:(?:use|pick|choose) (?:a )?random (?:full |first |last )?name|generate (?:a )?(?:random )?(?:full |first |last )?name|make up (?:a )?name)(?: for me| for this field)?(?: please)?$/.test(normalize(text)) }
export function invalidNameValue(text: string) { return /^(?:my (?:full |first |last )?name (?:is|would be)|i am|i['’]m)\b/.test(normalize(text)) || randomNameRequest(text) || ['random name', 'a random name', 'full name'].includes(normalize(text)) }
export function requestedNameValue(label: string, value: string, transcript: string, quote: string) {
  return isNameField(label) && randomNameRequest(transcript) && randomNameRequest(quote) && !invalidNameValue(value) && value.length <= 100 && /^[\p{L}\p{M} .'-]+$/u.test(value) && /\p{L}/u.test(value)
}
