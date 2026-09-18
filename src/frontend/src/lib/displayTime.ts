/**
 * Render a stored timestamp in the operator's timezone.
 *
 * Admiral stores UTC and always will — the display zone is a preference
 * (`display_timezone`, resolved server-side as preference -> ADMIRAL_TZ ->
 * America/Chicago) served by `GET /api/preferences/timezone`. The server has
 * had `formatInTz` for exactly this since the reporting work; the FRONTEND
 * never used it, so every pane rendered raw UTC and Brian kept reading times
 * that were five hours out. This is the missing half.
 *
 * **The trap that makes this worth a module.** The database writes bare
 * `"2026-09-18 03:11:58"` with no zone marker, and `new Date()` on that string
 * parses it as LOCAL time in every browser — so a naive
 * `new Date(ts).toLocaleString()` shows the right-looking clock while being
 * wrong by the whole UTC offset, and it is wrong in the direction that looks
 * plausible. `toUtcDate` pins the zone explicitly before any formatting.
 */
import { useEffect, useState } from 'react'

export const FALLBACK_TZ = 'America/Chicago'

/** Parse a stored stamp as UTC, whether or not it carries a zone marker. */
export function toUtcDate(ts: string | null | undefined): Date | null {
  if (!ts) return null
  const s = String(ts).trim()
  // Already zoned (…Z or ±HH:MM) — the browser will read it correctly.
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  const d = new Date(zoned)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Sep 17, 9:11 PM" in the given zone. Returns an em dash for an unusable stamp. */
export function formatStamp(ts: string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = toUtcDate(ts)
  if (!d) return '—'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', ...opts,
    }).format(d)
  } catch {
    // An invalid zone must not blank the column — fall back rather than throw.
    return new Intl.DateTimeFormat('en-US', { timeZone: FALLBACK_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts }).format(d)
  }
}

/** The short zone label ("CDT") for the given zone, for labelling a column once. */
export function tzAbbrev(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date())
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz
  } catch { return tz }
}

let cached: string | null = null

/**
 * The resolved zone for code that cannot use a hook (a module-level formatter, a
 * helper called from a render). Returns the fallback until the first
 * `useDisplayTimeZone()` on the page has resolved — which is correct-by-default
 * rather than wrong-by-default, because the fallback IS the configured zone for
 * this install. Prefer the hook where you can; it re-renders when the value lands.
 */
export function currentTimeZone(): string { return cached ?? FALLBACK_TZ }

/** Prime the cache without a component, e.g. at app start. */
export async function primeTimeZone(): Promise<string> {
  if (cached) return cached
  try {
    const r = await fetch('/api/preferences/timezone')
    const j = await r.json()
    if (j?.timezone) cached = String(j.timezone)
  } catch { /* fallback stands */ }
  return cached ?? FALLBACK_TZ
}

/**
 * The resolved display zone. Fetched once per page load and memoised across
 * components — every pane asking the server for the same preference on mount
 * would be a request per pane for a value that changes approximately never.
 */
export function useDisplayTimeZone(): string {
  const [tz, setTz] = useState<string>(cached ?? FALLBACK_TZ)
  useEffect(() => {
    if (cached) return
    void (async () => {
      try {
        const r = await fetch('/api/preferences/timezone')
        const j = await r.json()
        if (j?.timezone) { cached = String(j.timezone); setTz(cached) }
      } catch { /* keep the fallback; a missing preference must not break rendering */ }
    })()
  }, [])
  return tz
}
