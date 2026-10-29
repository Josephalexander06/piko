import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export function TranscriptEditor({ transcript, accept, discard, retry }: { transcript: string; accept: (text: string) => void; discard: () => void; retry: () => void }) {
  const [text, setText] = useState(transcript)
  return <section aria-label="Review voice transcript" className="space-y-3 rounded-lg border bg-white p-3">
    <label htmlFor="voice-transcript" className="text-sm font-medium">Edit your transcript</label>
    <Textarea id="voice-transcript" value={text} maxLength={4096} rows={4} onChange={event => setText(event.target.value)} />
    <p className="text-xs text-muted-foreground">Accepting adds this text to the conversation only. It does not interpret answers or authorize webpage changes.</p>
    <Button className="min-h-10 w-full" disabled={!text.trim()} onClick={() => accept(text.trim())}>Accept transcript</Button>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={retry}>Record again</Button><Button variant="ghost" onClick={discard}>Discard transcript</Button></div>
  </section>
}
