/**
 * Fleet health watch — error bursts, guard-block loops, stalled agents, and
 * agents whose own writing has run away with them.
 *
 * TIMESTAMP FORMAT MATTERS. log_entries.timestamp is SQLite datetime, "2026-09-04
 * 23:51:06" with a SPACE. An earlier version of this watch compared it against
 * `new Date().toISOString()`, which emits a "T": at index 10 a space (0x20)
 * sorts before "T" (0x54), so every `timestamp > ?` was false and the watch
 * matched nothing for hours while looking perfectly healthy. Silence from a
 * watcher must mean "checked and clear", never "never ran".
 *
 * Usage: bun scripts/fleet-health.ts [--once]
 */
import { Database } from 'bun:sqlite'

const ONCE = process.argv.includes('--once')
const INTERVAL_MS = 5 * 60 * 1000

/** SQLite datetime string N minutes ago — the format the column actually uses. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

/** Which agents are actually running an LLM loop right now.
 *
 *  A parked agent is not stalled, it is parked — and after a fleet-wide
 *  safe-dock this check fired "possible stalled loop" for six agents at once,
 *  every one of them deliberately shut down. Alerting on intended state is how
 *  a watcher trains its reader to ignore it. */
async function runningAgents(): Promise<Set<string>> {
  try {
    const r = await fetch('http://127.0.0.1:3031/api/profiles', { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return new Set()
    const rows = await r.json() as Array<{ id: string; running?: boolean }>
    return new Set(rows.filter(x => x.running).map(x => x.id))
  } catch {
    return new Set()   // server unreachable: report nothing rather than everything
  }
}

// Findings already reported, so a standing condition is announced ONCE and not
// re-announced every cycle for the 25 minutes its window keeps looking back.
// Cleared when the condition stops firing, so a genuine recurrence is loud again.
const reported = new Set<string>()

function announce(key: string, msg: string, firing: boolean): void {
  if (!firing) { reported.delete(key); return }
  if (reported.has(key)) return
  reported.add(key)
  console.log(msg)
}

async function sweep(): Promise<void> {
  const running = await runningAgents()
  if (running.size === 0) return          // whole fleet parked, or server down
  const db = new Database('data/admiral.db', { readonly: true })
  const recent = ago(6), wider = ago(25)
  const count = (sql: string, ...a: unknown[]) =>
    (db.query(sql).get(...a as never[]) as { c: number }).c

  for (const p of db.query('SELECT id, name FROM profiles WHERE enabled = 1').all() as Array<{ id: string; name: string }>) {
    const n = p.name.split(' - ')[0]
    if (!running.has(p.id)) {            // parked on purpose — nothing to report
      for (const k of ['err', 'blocked', 'silent', 'banner']) reported.delete(`${k}:${p.id}`)
      continue
    }

    const errs = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='error' AND timestamp>?`, p.id, recent)
    announce(`err:${p.id}`, `[fleet] ${n}: ${errs} errors in 6min`, errs >= 3)

    const blocked = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?
      AND (summary LIKE '%BLOCKED%' OR summary LIKE '%REFUSED%')`, p.id, recent)
    announce(`blocked:${p.id}`, `[fleet] ${n}: ${blocked} guard blocks in 6min — likely looping on a refused call`, blocked >= 4)

    const now = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, recent)
    const before = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, wider)
    announce(`silent:${p.id}`, `[fleet] ${n}: silent 6min after being active — possible stalled loop`, now === 0 && before > 0)

    // Runaway self-narration. Grit Vane hit 36% of his thoughts carrying alarm
    // framing ("CRITICAL STATE RECONCILIATION") against 1-2% for fleetmates on
    // the SAME model — a style loop through his own TODO, which he rewrites and
    // is then re-injected. Costs output tokens every turn and buries real alarms.
    const total = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='llm_thought' AND timestamp>?`, p.id, wider)
    if (total >= 20) {
      // Match the SHAPE, not a word list. The first version keyed on
      // CRITICAL/RECONCIL/🚨 and Grit Vane simply moved to
      // "**🎯 LIVE STATE CONFIRMED — CYCLE 171 STARTING**": identical ritual
      // preamble every turn, zero detections. A keyword watcher that an agent
      // can reword its way around is a false negative dressed as a clean bill.
      //
      // The tell is a thought OPENING with a bold banner — `**`, optionally
      // after a macro prefix like "[mine_until_full 3 mines, cargo 12/120] ".
      // Ordinary reasoning starts with a sentence.
      // A bare "**TODO** - Verified: <one line>" is a compact, useful note, not a
      // ritual alarm — Ledger Voss writes it while labelling his TODO update, and
      // counting it flagged him at 25% on a run with ZERO alarm framing in 65
      // turns. Excluding it keeps the signal on what actually costs output: a
      // bold banner announcing state as an event.
      const banner = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='llm_thought' AND timestamp>?
        AND (summary LIKE '**%' OR summary LIKE '[%] **%')
        AND summary NOT LIKE '**TODO**%' AND summary NOT LIKE '[%] **TODO**%'`, p.id, wider)
      const pct = Math.round((100 * banner) / total)
      announce(`banner:${p.id}`, `[fleet] ${n}: ${pct}% of thoughts open with a banner header (${banner}/${total} in 25min) — ritual restatement loop, rewrite TODO/memory in plain sentences`, pct >= 25)
    }
  }
  db.close()
}

await sweep()
if (!ONCE) {
  setInterval(() => { sweep().catch(() => {}) }, INTERVAL_MS)
  await new Promise(() => {})
}
