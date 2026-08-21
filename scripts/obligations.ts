/**
 * obligations — the fleet's standing financial drains: facility rents and taxes.
 *
 *   bun scripts/obligations.ts          # full register, active first, biggest drain first
 *   bun scripts/obligations.ts <agent>  # one agent
 *
 * Exists because a Crew Bunk + Ledger Desk rented at confederacy_central_command on
 * 2026-07-22 escalated from 15cr to 433cr per ~16-minute cycle and consumed on the
 * order of 2M credits before a wallet audit noticed. Nothing in Admiral surfaced it:
 * rent bills server-side while agents sleep, and the action-log ingestion swept only
 * item-moving categories. The register is only as complete as ingestion — an agent
 * that has never connected since the 'other' category was added has no rows yet.
 */
import { Database } from 'bun:sqlite'

const db = new Database('data/admiral.db', { readonly: true })
const names = Object.fromEntries(
  (db.query('SELECT id,name FROM profiles').all() as Array<{ id: string; name: string }>)
    .map((p) => [p.id, p.name.split(' ')[0]]),
)

const who = process.argv[2]
const rows = db.query(`SELECT * FROM recurring_obligations ORDER BY status = 'active' DESC, total_paid DESC`)
  .all() as Array<Record<string, any>>
const filtered = who
  ? rows.filter((r) => (names[r.profile_id] ?? '').toLowerCase().startsWith(who.toLowerCase()))
  : rows

if (!filtered.length) {
  console.log('no obligations recorded' + (who ? ` for "${who}"` : '') +
    ' — note: agents that have not connected since the other-category sweep shipped have no rows yet.')
  process.exit(0)
}

console.log('type  status  agent        where/what                                     per-cycle   paid-total  first..last seen')
let activeRentPerCycle = 0
for (const r of filtered) {
  const agent = (names[r.profile_id] ?? '?').padEnd(11)
  const what = `${r.facility} @ ${r.station_id}`.padEnd(46)
  const stale = (Date.now() - new Date(r.last_seen).getTime()) / 3_600_000 > 6
  const status = (r.status === 'active' && stale ? 'lapsed?' : r.status).padEnd(7)
  if (r.obligation_type === 'rent' && r.status === 'active' && !stale) activeRentPerCycle += r.last_cost
  console.log(`${r.obligation_type.padEnd(5)} ${status} ${agent} ${what} ${String(r.last_cost).padStart(9)}  ${String(r.total_paid).padStart(11)}  ${String(r.first_seen).slice(5, 16)}..${String(r.last_seen).slice(5, 16)}`)
}
if (activeRentPerCycle > 0) {
  // Observed cycle ≈ 16.5 min → ~87 cycles/day.
  console.log(`\nactive rent burn ≈ ${activeRentPerCycle}cr/cycle ≈ ${Math.round(activeRentPerCycle * 87).toLocaleString()}cr/day if cycles run ~16.5min`)
}
