/**
 * procurement-audit — what the fleet paid vs what it could have paid.
 *
 *   bun scripts/procurement-audit.ts [hours]     # default 6
 *
 * Agents price locally because `view_market` only shows the station they are
 * docked at, and prices differ enormously between empires. Nobody sees the gap
 * from inside the game: the Admiral has HTTP and the agents do not.
 *
 * Measured 2026-09-06 over six hours: ~32,650 credits of avoidable spend across
 * eight items. Nova Reyes paid 4,264 each for control_node with crimson asking
 * 2,844 at depth 7 (~15,600 on one purchase); the fleet paid 61 for
 * ferrous_slug_case against 7 in nebula at a depth of 43,061.
 *
 * Depth is the whole point of the last column. A cheaper empire is only worth
 * routing to if it can actually supply the quantity — a headline ask at depth 1
 * is not a source, and this is the same `min(held, depth)` rule that governs
 * selling. The script reports; the judgement about whether a trip pays is the
 * Admiral's.
 */
import { Database } from 'bun:sqlite'

const HOURS = Number(Bun.argv[2] ?? 6)
const OVERPAY_PCT = 25          // below this is noise: fees, rounding, a moved book

const db = new Database('data/admiral.db', { readonly: true })

async function feed(): Promise<any> {
  const path = 'data/.cache/market.json'
  try {
    const f = Bun.file(path)
    if (await f.exists() && Date.now() - (await f.stat()).mtimeMs < 10 * 60_000) return JSON.parse(await f.text())
  } catch { /* refetch */ }
  try {
    const res = await fetch('https://game.spacemolt.com/api/market', { signal: AbortSignal.timeout(60_000) })
    if (res.ok) { const t = await res.text(); await Bun.write(path, t); return JSON.parse(t) }
  } catch { /* fall through */ }
  const f = Bun.file(path)
  if (await f.exists()) { console.error('WARNING: market feed unreachable, using cached copy'); return JSON.parse(await f.text()) }
  throw new Error('market feed unreachable and no cache')
}

const mkt = await feed()
const rows: any[] = Array.isArray(mkt) ? mkt : (mkt.items ?? Object.values(mkt))
const byItem = new Map<string, any[]>()
for (const r of rows) {
  const id = r?.item_id ?? r?.id
  if (id) byItem.set(id, [...(byItem.get(id) ?? []), r])
}

interface Buy { item_id: string; qty: number; paid: number; n: number; who: string }
const buys = db.query(`
  SELECT l.item_id, SUM(l.quantity) qty, SUM(-l.amount_signed) spent, COUNT(*) n,
         GROUP_CONCAT(DISTINCT p.name) who
  FROM financial_ledger l JOIN profiles p ON p.id = l.profile_id
  WHERE l.kind = 'buy' AND l.item_id IS NOT NULL
    AND l.timestamp > datetime('now', ?)
  GROUP BY l.item_id HAVING SUM(l.quantity) > 0
`).all(`-${HOURS} hours`) as Array<{ item_id: string; qty: number; spent: number; n: number; who: string }>

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const findings: Array<{ line: string; waste: number }> = []
let waste = 0

for (const b of buys) {
  const paid = b.spent / b.qty
  // Cheapest empire that could actually have supplied this quantity at its best ask.
  const supplier = (byItem.get(b.item_id) ?? [])
    .filter(r => r.best_ask > 0 && (r.ask_quantity_at_best ?? 0) >= b.qty)
    .sort((a, c) => a.best_ask - c.best_ask)[0]
  if (!supplier || !paid) continue
  const over = ((paid - supplier.best_ask) / supplier.best_ask) * 100
  if (over < OVERPAY_PCT) continue
  const w = (paid - supplier.best_ask) * b.qty
  waste += w
  findings.push({
    waste: w,
    line: `  ${b.item_id.padEnd(22)} x${String(Math.round(b.qty)).padStart(5)}  paid ${n(paid).padStart(7)}  vs ${n(supplier.best_ask).padStart(7)} in ${String(supplier.empire).padEnd(9)} (depth ${supplier.ask_quantity_at_best})  ${('+' + Math.round(over) + '%').padStart(6)}  = ${n(w).padStart(8)} lost   [${b.who}]`,
  })
}

findings.sort((a, b) => b.waste - a.waste)
console.log(`=== procurement audit, last ${HOURS}h — buys at least ${OVERPAY_PCT}% over a source that had the depth ===\n`)
if (!findings.length) { console.log('  nothing over threshold.'); process.exit(0) }
for (const f of findings) console.log(f.line)
console.log(`\n  avoidable spend: ${n(waste)} credits`)
console.log(`\n  Caveat: a cheaper empire only pays if the agent is headed there or the quantity justifies the trip.`)
console.log(`  Relay this to faction chat rather than ordering a route — the agent knows where it is standing.`)
