/**
 * One place that knows the database stores UTC.
 *
 * SQLite's `datetime('now')` returns UTC with no zone marker — "2026-09-15
 * 16:48:06". Handing that string to `new Date()` or `Date.parse()` makes
 * JavaScript read it as LOCAL time, so on a US Central machine every such
 * timestamp lands five hours in the future.
 *
 * That is not cosmetic. `isObligationLapsed()` and the rent nag in briefing.ts
 * both computed `staleH = (now - Date.parse(last_seen)) / 3_600_000` on a bare
 * timestamp, so staleness came out five hours short and the "lapsed?" warning
 * needed ELEVEN real hours to fire instead of six. The fleet spent the morning
 * of 2026-09-15 discovering ~99,500 cr/week of crew-bunk rent draining out of
 * two agents; the briefing that was supposed to flag exactly that had been
 * quietly suppressed by this parse.
 *
 * The rows are not even consistent: collector-written tables (recurring_obligations)
 * store ISO-with-Z, while every `DEFAULT (datetime('now'))` column stores the bare
 * form. Anything reading a timestamp must therefore handle both, which is what
 * `parseDbTime` is for.
 */

/** Preference key holding an IANA zone name for display, e.g. "America/Chicago". */
export const DISPLAY_TZ_KEY = 'display_timezone'

/** Used when nothing is configured. IANA, not a fixed offset — see below. */
export const DEFAULT_DISPLAY_TZ = 'America/Chicago'

/**
 * Normalise a database timestamp to a real ISO instant.
 *
 * Accepts "2026-09-15 16:48:06", "2026-09-15T16:48:06", "…Z" and "…+01:00".
 * Only the zone-less forms are altered — an explicit offset is already correct
 * and must be left alone.
 */
export function toISO(ts: string): string {
  let s = String(ts).trim().replace(' ', 'T')
  // An offset can only appear after the date part, so look for '-' past index 10.
  const hasZone = s.endsWith('Z') || s.includes('+') || s.includes('-', 10)
  if (!hasZone) s += 'Z'
  return s
}

/** Epoch milliseconds for a database timestamp, or NaN if it is unparseable. */
export function parseDbTime(ts: string | null | undefined): number {
  if (!ts) return NaN
  return Date.parse(toISO(ts))
}

/** Hours between a database timestamp and `now`. NaN when unparseable. */
export function hoursSince(ts: string | null | undefined, now: number = Date.now()): number {
  const t = parseDbTime(ts)
  return Number.isFinite(t) ? (now - t) / 3_600_000 : NaN
}

/**
 * Render a database timestamp in the operator's zone.
 *
 * An IANA NAME is stored rather than an offset on purpose: "CST" is UTC-6 and
 * "CDT" is UTC-5, and a fleet that runs unattended overnight will cross the
 * boundary twice a year. "America/Chicago" is right on both sides of it.
 */
export function formatInTz(ts: string | null | undefined, tz: string = DEFAULT_DISPLAY_TZ, opts: Intl.DateTimeFormatOptions = {}): string {
  const t = parseDbTime(ts)
  if (!Number.isFinite(t)) return String(ts ?? '')
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: tz, timeZoneName: 'short',
      ...opts,
    }).format(new Date(t))
  } catch {
    // An invalid zone name must not take down whatever was rendering a log line.
    return new Date(t).toISOString()
  }
}

/** True when the string names a zone this runtime can actually format in. */
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/**
 * The configured display zone.
 *
 * Order: stored preference, then ADMIRAL_TZ in the environment, then Central.
 * An unrecognised value falls through rather than throwing — a bad preference
 * should degrade to a sane clock, not break every timestamp on the dashboard.
 */
export function resolveDisplayTimeZone(stored: string | null, env: string | undefined = process.env.ADMIRAL_TZ): string {
  for (const cand of [stored, env]) {
    if (cand && isValidTimeZone(cand)) return cand
  }
  return DEFAULT_DISPLAY_TZ
}
