/** Match only literal text or explicitly spoken email punctuation. The source
 * quote itself must still be an exact excerpt of the current transcript. */
export function supportedText(kind: string, value: string, quote: string): boolean {
  const normalize = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (normalize(quote).includes(normalize(value))) return true
  if (kind !== 'email') return false
  let text = normalize(quote)
  for (const [word, symbol] of [['at', '@'], ['dot', '.'], ['underscore', '_'], ['dash', '-'], ['hyphen', '-']]) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), symbol)
  text = text.replace(/\s*([@._-])\s*/g, '$1')
  return (text.match(/[^\s@<>()[\]{},;:"]+@[a-z0-9.-]+/g) ?? []).some(candidate => candidate.replace(/\.+$/, '') === normalize(value))
}
