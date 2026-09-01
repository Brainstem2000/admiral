/** Shared primitives for the Character dossier tabs — the ShipTab visual language:
 *  Chakra Petch display headers, percentage-labeled bars, tabular stat cells,
 *  colored status chips, and "as of Ns ago" freshness stamps. */
import { useEffect, useState } from 'react'

/** Display face for headers/labels — Chakra Petch is linked in index.html (500/600/700). */
export const DISPLAY: React.CSSProperties = { fontFamily: '"Chakra Petch", "Arial Narrow", sans-serif' }

/** Credits formatter: 1.2M / 45k / 999 (sign preserved). */
export function fmtCr(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1_000)}k`
  return `${sign}${abs.toLocaleString()}`
}
export function fmtSigned(n: number): string { return n > 0 ? `+${fmtCr(n)}` : fmtCr(n) }

/** Parse sqlite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO timestamps to epoch ms; 0 on failure. */
export function parseTs(ts: string): number {
  if (!ts) return 0
  const t = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : 0
}

/** Relative age: now / 5m / 3h / 2d. */
export function ageOf(ts: string | null | undefined): string {
  if (!ts) return '—'
  const ms = Date.now() - parseTs(ts)
  if (ms < 0 || !Number.isFinite(ms) || parseTs(ts) === 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s < 5 ? 'now' : `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** "as of Ns ago" freshness stamp — self-ticking so it never reads stale. */
export function Freshness({ at, prefix = 'as of' }: { at: string | number | null; prefix?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 5000)
    return () => clearInterval(t)
  }, [])
  if (at == null) return null
  const ms = typeof at === 'number' ? at : parseTs(at)
  if (!ms) return null
  const iso = new Date(ms).toISOString()
  const age = ageOf(iso)
  return (
    <span className="text-[9px] text-muted-foreground/50 tabular-nums whitespace-nowrap" title={iso}>
      {prefix} {age === 'now' ? 'just now' : `${age} ago`}
    </span>
  )
}

/** Percentage-labeled progress bar (ShipTab's Bar). flagHigh turns it orange past 90%. */
export function Bar({ icon, label, color, cur, max, suffix, flagHigh, flagLow }: {
  icon?: React.ReactNode; label: string; color: string; cur: number; max: number
  suffix?: string
  /** warn when nearly full (fitting budgets) */
  flagHigh?: boolean
  /** warn when nearly empty (fuel, ammo) */
  flagLow?: boolean
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  const hot = (flagHigh && pct > 90) || (flagLow && pct < 15)
  const barColor = hot ? 'var(--smui-orange)' : color
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        {icon && <span style={{ color: `hsl(${barColor})` }}>{icon}</span>}
        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] flex-1 truncate" style={DISPLAY}>{label}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">{Math.round(pct)}%</span>
        <span className="text-xs tabular-nums text-foreground/90">
          {cur.toLocaleString()}<span className="text-muted-foreground/50">/{max.toLocaleString()}{suffix || ''}</span>
        </span>
      </div>
      <div className="h-2 w-full bg-border/40 overflow-hidden">
        <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: `hsl(${barColor})` }} />
      </div>
    </div>
  )
}

/** Labeled stat with optional accent color, hover hint, delta line, and sub note. */
export function StatCell({ label, value, accent, hint, delta, sub }: {
  label: string; value: string; accent?: string; hint?: string
  /** signed change — rendered green/red beside the value */
  delta?: number | null
  sub?: string
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-0.5" style={DISPLAY}>{label}</div>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-sm font-semibold tabular-nums truncate" style={accent ? { color: `hsl(${accent})` } : undefined}>{value}</span>
        {delta != null && delta !== 0 && (
          <span className="text-[10px] tabular-nums shrink-0" style={{ color: `hsl(${delta >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'})` }}>
            {fmtSigned(delta)}
          </span>
        )}
      </div>
      {sub && <div className="text-[9px] text-muted-foreground/60 truncate">{sub}</div>}
    </div>
  )
}

/** Colored status chip — the dossier's bordered uppercase tag. */
export function Chip({ label, color = 'var(--muted-foreground)', title, filled }: {
  label: string; color?: string; title?: string; filled?: boolean
}) {
  return (
    <span
      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border whitespace-nowrap"
      style={{
        color: `hsl(${color})`,
        borderColor: `hsl(${color} / 0.4)`,
        ...(filled ? { background: `hsl(${color} / 0.08)` } : undefined),
      }}
      title={title}
    >
      {label}
    </span>
  )
}

/** Section sub-header inside a card body (category strips, table headers use DISPLAY directly). */
export function SectionLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] uppercase tracking-[1.5px] text-muted-foreground ${className}`} style={DISPLAY}>
      {children}
    </div>
  )
}
