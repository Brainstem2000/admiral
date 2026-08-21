/**
 * fleet-accounts — the self-accounting layer in one view.
 *
 *   bun scripts/fleet-accounts.ts             # all six views
 *   bun scripts/fleet-accounts.ts --backfill  # one-time: fold surviving llm_call log rows
 *                                             # into llm_spend_daily (idempotent-ish: run once)
 *
 * Views: LLM spend by agent-day · insurance policies (with expiry warnings) · empire policy
 * history · ship registry + active-ship modules · freight P&L · wallet daily closes.
 * All backing tables are never pruned; each exists because its absence cost something real.
 */
import { Database } from 'bun:sqlite'

const db = new Database('data/admiral.db')
const names: Record<string, string> = Object.fromEntries(
  (db.query('SELECT id,name FROM profiles').all() as Array<{ id: string; name: string }>)
    .map((p) => [p.id, p.name.split(' ')[0]]),
)
const N = (id: string) => names[id] ?? id.slice(0, 8)

if (process.argv.includes('--backfill')) {
  // llm_call detail JSON carries usage+cost; log_entries prunes at 14 days, so this rescues
  // whatever history still exists. Uses INSERT..DO UPDATE the same as live capture, so running
  // it twice double-counts — hence the guard below.
  const existing = (db.query('SELECT COUNT(*) n FROM llm_spend_daily').get() as { n: number }).n
  if (existing > 0) {
    console.log(`llm_spend_daily already has ${existing} rows — refusing to backfill on top (double-count risk).`)
    process.exit(1)
  }
  const rows = db.query(
    "SELECT profile_id, timestamp, detail FROM log_entries WHERE type='llm_call' AND detail LIKE '%usage%'",
  ).all() as Array<{ profile_id: string; timestamp: string; detail: string }>
  const ins = db.query(`INSERT INTO llm_spend_daily (profile_id, day, model, calls, cost, input_tokens, output_tokens, cache_read, cache_write)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, day, model) DO UPDATE SET
      calls = calls + 1, cost = cost + excluded.cost,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write`)
  let ok = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      try {
        const d = JSON.parse(r.detail)
        const u = d.usage ?? {}
        const cost = typeof u.cost === 'object' ? (u.cost.total ?? 0) : (u.cost ?? 0)
        ins.run(r.profile_id, r.timestamp.slice(0, 10), d.model ?? '?', cost,
          u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0)
        ok++
      } catch { /* skip malformed */ }
    }
  })
  tx()
  console.log(`backfilled ${ok} llm_call rows into llm_spend_daily`)
  process.exit(0)
}

console.log('=== LLM SPEND (per agent-day, durable) ===')
for (const r of db.query(`SELECT profile_id, day, SUM(calls) calls, ROUND(SUM(cost),2) cost
  FROM llm_spend_daily GROUP BY profile_id, day ORDER BY day DESC, cost DESC LIMIT 20`).all() as any[])
  console.log(`  ${r.day} ${N(r.profile_id).padEnd(12)} ${String(r.calls).padStart(5)} calls  $${r.cost}`)
const tot = db.query('SELECT ROUND(SUM(cost),2) c, SUM(calls) n FROM llm_spend_daily').get() as any
console.log(`  ALL-TIME RECORDED: $${tot.c ?? 0} across ${tot.n ?? 0} calls`)

console.log('\n=== INSURANCE POLICIES ===')
const pol = db.query('SELECT * FROM insurance_policies ORDER BY expires_at').all() as any[]
if (!pol.length) console.log('  (none recorded — populates as `policies` results pass through agents)')
for (const p of pol) {
  const daysLeft = (new Date(p.expires_at).getTime() - Date.now()) / 86_400_000
  const flag = !Number.isFinite(daysLeft) ? '' : daysLeft < 0 ? '  ⚠ EXPIRED' : daysLeft < 2 ? `  ⚠ expires in ${daysLeft.toFixed(1)}d` : ''
  console.log(`  ${N(p.profile_id).padEnd(12)} ${p.ship_class.padEnd(12)} cover ${String(p.coverage).padStart(8)}  premium ${String(p.premium).padStart(7)}  expires ${String(p.expires_at).slice(0, 10)}${flag}`)
}

console.log('\n=== EMPIRE POLICY (latest per empire; alert on change) ===')
for (const e of db.query(`SELECT empire, MAX(fetched_at) f, property_rate, income_rate, sales_citizen_rate, eviction_grace_cycles, fuel_tax,
  (SELECT COUNT(DISTINCT property_rate || income_rate) FROM empire_policy_snapshots s2 WHERE s2.empire = s1.empire) variants
  FROM empire_policy_snapshots s1 GROUP BY empire`).all() as any[])
  console.log(`  ${e.empire.padEnd(9)} prop ${e.property_rate.padEnd(6)} income ${e.income_rate.padEnd(6)} sales ${e.sales_citizen_rate.padEnd(6)} evict ${e.eviction_grace_cycles}cy fuel+${e.fuel_tax}  @${String(e.f).slice(5, 16)}${e.variants > 1 ? '  ⚠ RATES HAVE CHANGED (' + e.variants + ' variants seen)' : ''}`)

console.log('\n=== SHIP REGISTRY (live-synced on every list_ships) ===')
for (const s of db.query(`SELECT profile_id, station_id, class, COUNT(*) n FROM storage_ships
  GROUP BY profile_id, station_id, class ORDER BY profile_id`).all() as any[])
  console.log(`  ${N(s.profile_id).padEnd(12)} ${String(s.class).padEnd(20)} x${s.n}  @${s.station_id === '__active__' ? 'ACTIVE' : s.station_id}`)
console.log('  -- active-ship modules --')
for (const m of db.query('SELECT profile_id, module_name, slot, cpu, power FROM ship_modules ORDER BY profile_id').all() as any[])
  console.log(`  ${N(m.profile_id).padEnd(12)} ${m.module_name.padEnd(22)} ${m.slot.padEnd(8)} cpu ${m.cpu} pwr ${m.power}`)

console.log('\n=== FREIGHT P&L ===')
const f = db.query(`SELECT status, COUNT(*) n, SUM(base_reward) reward FROM freight_contracts GROUP BY status`).all() as any[]
if (!f.length) console.log('  (none recorded yet — populates from shipping boards/completions)')
for (const r of f) console.log(`  ${r.status.padEnd(10)} x${String(r.n).padStart(3)}  rewards ${Number(r.reward).toLocaleString()}`)

console.log('\n=== WALLET DAILY CLOSES (latest day per agent) ===')
for (const w of db.query(`SELECT profile_id, day, close_balance, min_balance, max_balance FROM wallet_daily w1
  WHERE day = (SELECT MAX(day) FROM wallet_daily w2 WHERE w2.profile_id = w1.profile_id) ORDER BY close_balance DESC`).all() as any[])
  console.log(`  ${N(w.profile_id).padEnd(12)} ${w.day}  close ${String(w.close_balance).padStart(9)}  range ${w.min_balance}..${w.max_balance}`)

console.log('\n=== SYSTEM DANGER BOARD (non-SAFE current grades + 7d trend) ===')
try {
  const days = db.query(`SELECT system_id, day, grade FROM system_danger_daily
    WHERE day >= date('now','-7 days') ORDER BY system_id, day`).all() as any[]
  const bySys = new Map<string, any[]>()
  for (const d of days) { if (!bySys.has(d.system_id)) bySys.set(d.system_id, []); bySys.get(d.system_id)!.push(d) }
  let shown = 0
  for (const [sys, rows] of bySys) {
    const latest = rows[rows.length - 1]
    if (latest.grade === 'SAFE') continue
    const first = rows[0]
    const trend = rows.length < 2 ? '' : first.grade === latest.grade ? '  (steady)' : `  (was ${first.grade} ${first.day})`
    console.log(`  ${sys.padEnd(20)} ${latest.grade.padEnd(10)} as of ${latest.day}${trend}`)
    shown++
  }
  if (!shown) console.log('  (no non-SAFE grades snapshotted yet — populates as fleet_route runs)')
} catch { console.log('  (system_danger_daily absent — deploys with next binary)') }
