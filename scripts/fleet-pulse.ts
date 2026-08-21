/**
 * fleet-pulse — catch agents doing NOTHING PRODUCTIVE, which the needs-admiral watcher
 * cannot see. needs-admiral fires when an agent ASKS for help; this fires when one is
 * silently stalled, looping on the same call, erroring, or the server itself is gone.
 *
 *   bun scripts/fleet-pulse.ts           # watch mode: one line per problem + hourly FLEETWATCH
 *   bun scripts/fleet-pulse.ts --once    # single sweep, print status, exit (for testing)
 *
 * Built 2026-08-21 for the first overnight autonomous watch. Design rules:
 *   - SILENT unless something needs the Admiral. Noise is what gets monitors switched off.
 *   - Every alert deduped per agent for 30 min — a stalled agent is stalled once, not
 *     once per poll.
 *   - The hourly FLEETWATCH line fires unconditionally: it is the heartbeat that wakes
 *     the Admiral for a scheduled review, and leads with UTC + local time per doctrine.
 */
import { Database } from 'bun:sqlite'

const DB = 'data/admiral.db'
const API = 'http://127.0.0.1:3031/api/profiles'
const POLL_MS = 600_000            // 10 min sweeps
const STALL_MIN = 12               // no log rows at all for this long => stalled
const DEDUPE_MS = 30 * 60_000
const HOUR_MS = 60 * 60_000

const once = process.argv.includes('--once')
const db = new Database(DB, { readonly: true })
const lastAlert = new Map<string, number>()

function dedupe(key: string): boolean {
  const now = Date.now()
  const prev = lastAlert.get(key) ?? 0
  if (now - prev < DEDUPE_MS) return true
  lastAlert.set(key, now)
  return false
}

async function connectedAgents(): Promise<Array<{ id: string; name: string }> | null> {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const all = await res.json() as Array<{ id: string; name: string; connected?: boolean }>
    return all.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name.split(' ')[0] }))
  } catch {
    return null // server unreachable — the caller raises the alarm
  }
}

function sweep(agents: Array<{ id: string; name: string }>): string[] {
  const out: string[] = []
  for (const a of agents) {
    const last = db.query(
      'SELECT timestamp FROM log_entries WHERE profile_id = ? ORDER BY id DESC LIMIT 1',
    ).get(a.id) as { timestamp: string } | null
    const ageMin = last ? (Date.now() - new Date(last.timestamp.replace(' ', 'T') + 'Z').getTime()) / 60_000 : Infinity

    if (ageMin > STALL_MIN) {
      if (!dedupe(`stall|${a.id}`)) out.push(`STALLED ${a.name}: no log activity for ${Math.round(ageMin)} min`)
      continue // a stalled agent can't also be looping
    }

    // Loop detection: the last 8 tool_calls collapse to one repeated command.
    const calls = db.query(
      "SELECT summary, timestamp FROM log_entries WHERE profile_id = ? AND type = 'tool_call' ORDER BY id DESC LIMIT 8",
    ).all(a.id) as Array<{ summary: string; timestamp: string }>
    if (calls.length === 8) {
      const heads = new Set(calls.map((c) => c.summary.replace(/\s+/g, ' ').slice(0, 45)))
      const spanMin = (new Date(calls[0].timestamp.replace(' ', 'T') + 'Z').getTime()
        - new Date(calls[7].timestamp.replace(' ', 'T') + 'Z').getTime()) / 60_000
      if (heads.size === 1 && spanMin < 15) {
        if (!dedupe(`loop|${a.id}`)) out.push(`LOOPING ${a.name}: 8x "${[...heads][0]}" in ${Math.round(spanMin)} min`)
      }
    }

    // Error burst: repeated failures in the last 10 minutes.
    const errs = db.query(
      "SELECT COUNT(*) n FROM log_entries WHERE profile_id = ? AND timestamp > datetime('now','-10 minutes') AND (type = 'error' OR summary LIKE 'Error:%')",
    ).get(a.id) as { n: number }
    if (errs.n >= 4 && !dedupe(`err|${a.id}`)) {
      const ex = db.query(
        "SELECT summary FROM log_entries WHERE profile_id = ? AND (type='error' OR summary LIKE 'Error:%') ORDER BY id DESC LIMIT 1",
      ).get(a.id) as { summary: string } | null
      out.push(`ERRORS ${a.name}: ${errs.n} in 10 min — ${(ex?.summary ?? '').replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  return out
}

function fleetwatch(agents: Array<{ id: string; name: string }>): string {
  const utc = new Date().toISOString().slice(11, 16)
  const local = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' })
  const parts: string[] = []
  for (const a of agents) {
    const credits = db.query(
      "SELECT summary FROM log_entries WHERE profile_id = ? AND summary LIKE '%cr %' AND (summary LIKE '%Ship:%' OR summary LIKE '%credits:%' OR summary LIKE '%Credits %') ORDER BY id DESC LIMIT 1",
    ).get(a.id) as { summary: string } | null
    const m = credits?.summary.match(/(?:\| |redits[: ]+)([\d,]+)\s?cr/i) ?? credits?.summary.match(/credits: (\d+)/)
    const acts = db.query(
      "SELECT COUNT(*) n FROM log_entries WHERE profile_id = ? AND type = 'tool_call' AND timestamp > datetime('now','-60 minutes')",
    ).get(a.id) as { n: number }
    const done = db.query(
      "SELECT COUNT(*) n FROM log_entries WHERE profile_id = ? AND summary LIKE '%DONE:%' AND timestamp > datetime('now','-60 minutes')",
    ).get(a.id) as { n: number }
    parts.push(`${a.name} ${m ? m[1] + 'cr' : '?cr'} ${acts.n}act/${done.n}done`)
  }
  return `FLEETWATCH ${utc}Z/${local}CT ${parts.join(' | ')}`
}

let lastHourly = Date.now()
let morningFired = false

async function tick(force = false) {
  // data/.fleet-idle marks a PLANNED stand-down (Admiral disconnected the fleet on purpose).
  // While it exists, an empty fleet is not an incident and the hourly heartbeat would be
  // an empty line — but the server-down alarm and the morning alarm must survive.
  const plannedIdle = await Bun.file('data/.fleet-idle').exists()
  const agents = await connectedAgents()
  if (agents === null) {
    if (!dedupe('server-down')) console.log('ADMIRAL-SERVER-DOWN: API on :3031 unreachable — agents may be orphaned')
    return
  }
  if (agents.length === 0 && !plannedIdle && !dedupe('none-connected')) {
    console.log('NO-AGENTS-CONNECTED: zero connected profiles — was the fleet meant to be running?')
  }
  for (const line of sweep(agents)) console.log(line)

  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  if (!morningFired && ct.getHours() === 8 && ct.getMinutes() >= 45) {
    morningFired = true
    console.log('MORNING-REPORT-DUE: compile the overnight summary for the user (09:00 CT return)')
  }
  if ((force || Date.now() - lastHourly >= HOUR_MS) && !(plannedIdle && agents.length === 0)) {
    lastHourly = Date.now()
    console.log(fleetwatch(agents))
  }
}

if (once) {
  await tick(true)
  process.exit(0)
}
await tick(true) // fire one FLEETWATCH immediately so the watch starts with a baseline
setInterval(tick, POLL_MS)
setInterval(() => {}, 1 << 30)
