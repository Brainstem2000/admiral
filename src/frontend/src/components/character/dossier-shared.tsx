/** Shared dossier primitives.
 *
 *  These are the small presentational pieces the dossier-style panes are built
 *  from (character tabs, faction command view). They live here so a pane can
 *  render a stat grid or a status chip without redefining one locally and
 *  drifting from the rest.
 *
 *  Colour convention, matching the rest of the app: callers pass a raw custom
 *  property such as `var(--smui-green)`, and the component wraps it in
 *  `hsl(...)`. The `--smui-*` tokens are bare HSL triplets, so they are NOT
 *  usable as a colour on their own.
 */
import { useEffect, useState } from 'react'

/** Display typeface for labels and headings. */
export const DISPLAY: React.CSSProperties = { fontFamily: '"Chakra Petch", "Arial Narrow", sans-serif' }

/** One labelled figure in a stat grid. `hint` becomes a native tooltip, which
 *  is where the caveats behind a number belong (e.g. treasury being
 *  withdrawable only where a lockbox exists). */
export function StatCell({ label, value, accent, hint }: {
  label: string
  value: string
  accent?: string
  hint?: string
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-0.5" style={DISPLAY}>{label}</div>
      <div className="text-sm font-semibold tabular-nums truncate" style={accent ? { color: `hsl(${accent})` } : undefined}>{value}</div>
    </div>
  )
}

/** A small status pill. `filled` inverts it for states that should draw the
 *  eye (at war, blocked, offline) rather than merely be readable. */
export function Chip({ label, color = 'var(--muted-foreground)', filled, title }: {
  label: string
  color?: string
  filled?: boolean
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.1em] font-semibold whitespace-nowrap border"
      style={{
        ...DISPLAY,
        color: filled ? 'hsl(var(--background))' : `hsl(${color})`,
        background: filled ? `hsl(${color})` : `hsl(${color} / 0.12)`,
        borderColor: `hsl(${color} / ${filled ? 1 : 0.4})`,
      }}
    >
      {label}
    </span>
  )
}

function relativeAge(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 10) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** How old the data on screen is. This is deliberately always visible rather
 *  than shown only once it is stale: a snapshot that looks live but is an hour
 *  old is exactly how a decision gets made against numbers that have moved.
 *  Re-renders on its own so the age stays honest without a parent poll. */
export function Freshness({ at, className }: { at?: string | null; className?: string }) {
  const [, force] = useState(0)

  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  if (!at) return null
  return (
    <span
      className={`text-[10px] text-muted-foreground/70 tabular-nums ${className ?? ''}`}
      title={new Date(at).toLocaleString()}
    >
      updated {relativeAge(at)}
    </span>
  )
}
