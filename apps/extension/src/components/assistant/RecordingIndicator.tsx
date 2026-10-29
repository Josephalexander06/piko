export function RecordingIndicator({ elapsedMs }: { elapsedMs: number }) {
  return <p role="status" className="flex items-center gap-2 text-sm font-medium text-red-800"><span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-red-600 motion-reduce:animate-none" />Recording · {Math.floor(elapsedMs / 1000)} / 20 seconds</p>
}
