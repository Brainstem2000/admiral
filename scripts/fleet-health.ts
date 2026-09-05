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

function sweep(): void {
  const db = new Database('data/admiral.db', { readonly: true })
  const recent = ago(6), wider = ago(25)
  const count = (sql: string, ...a: unknown[]) =>
    (db.query(sql).get(...a as never[]) as { c: number }).c

  for (const p of db.query('SELECT id, name FROM profiles WHERE enabled = 1').all() as Array<{ id: string; name: string }>) {
    const n = p.name.split(' - ')[0]

    const errs = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='error' AND timestamp>?`, p.id, recent)
    if (errs >= 3) console.log(`[fleet] ${n}: ${errs} errors in 6min`)

    const blocked = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?
      AND (summary LIKE '%BLOCKED%' OR summary LIKE '%REFUSED%')`, p.id, recent)
    if (blocked >= 4) console.log(`[fleet] ${n}: ${blocked} guard blocks in 6min — likely looping on a refused call`)

    const now = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, recent)
    const before = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND timestamp>?`, p.id, wider)
    if (now === 0 && before > 0) console.log(`[fleet] ${n}: silent 6min after being active — possible stalled loop`)

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
      const banner = count(`SELECT COUNT(*) c FROM log_entries WHERE profile_id=? AND type='llm_thought' AND timestamp>?
        AND (summary LIKE '**%' OR summary LIKE '[%] **%')`, p.id, wider)
      const pct = Math.round((100 * banner) / total)
      if (pct >= 25) console.log(`[fleet] ${n}: ${pct}% of thoughts open with a banner header (${banner}/${total} in 25min) — ritual restatement loop, rewrite TODO/memory in plain sentences`)
    }
  }
  db.close()
}

sweep()
if (!ONCE) {
  setInterval(sweep, INTERVAL_MS)
  await new Promise(() => {})
}
