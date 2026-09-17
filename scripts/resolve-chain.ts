/**
 * Resolve a build target to RAW inputs, following every recipe down until each
 * leaf is either buyable, mineable, or in stock.
 *
 * Written because checking one level and extrapolating produced a wrong answer
 * twice on 2026-09-15: the Breeder Reactor Core was recommended after verifying
 * only that ITS bill was affordable, without checking that its FUEL could be
 * made; and the whole neutronium chain was then declared impossible because
 * three items were "not sold anywhere", when every one of them has a recipe.
 * "Not on the market" is not the same as "cannot be obtained".
 */
import { Database } from 'bun:sqlite'
const db = new Database('data/admiral.db', { readonly: true })
const SP = '/private/tmp/claude-501/-Users-brian-dev-admiral/f84fbf31-42dd-4a19-816b-2ea4642b2bd1/scratchpad'
const cat: any = await Bun.file(SP + '/cat.json').json()
let recs: any = cat.recipes; if (Array.isArray(recs)) { const m: any = {}; for (const r of recs) m[r.id] = r; recs = m }
let facs: any = cat.facilities; if (Array.isArray(facs)) { const m: any = {}; for (const f of facs) m[f.id] = f; facs = m }
const mkt: any[] = (await Bun.file(SP + '/mkt3.json').json()).items
const ask: Record<string, [number, number, string]> = {}
for (const r of mkt) { const a = r.best_ask || 0, q = r.ask_quantity_at_best || 0
  if (a && q) { const k = r.item_id; if (!ask[k] || a < ask[k][0]) ask[k] = [a, q, r.empire] } }
const stock = (it: string) => {
  const p = (db.query('select coalesce(sum(quantity),0) q from storage_inventory where item_id=? and quantity>0').get(it) as any).q
  const f = (db.query('select coalesce(sum(quantity),0) q from faction_storage_inventory where item_id=? and quantity>0').get(it) as any).q
  return p + f }
const knownFac = new Set((db.query('select distinct facility_type from fleet_intel_facilities').all() as any[]).map(r => r.facility_type))

const target = process.argv[2], qty = Number(process.argv[3] || 1)
const buy: Record<string, number> = {}, mine: Record<string, number> = {}
const need: Record<string, number> = {}, used: Record<string, number> = {}
const facNeeded = new Map<string, { recipe: string, have: boolean, cheapest: string, cost: number }>()
const avail: Record<string, number> = {}

// Items currently being resolved further up the stack. A recipe whose inputs
// lead back to one of these closes a CYCLE and is not a source: wrap_X <-> unwrap_X
// is packaging, and following it invents the item out of nothing. On 2026-09-15
// that made 18 neutronium_ingot resolve to 964 lead_ore instead of 25,864, because
// unwrap_reactor_grade_plutonium won the "facility we already have" preference over
// breed_plutonium — the only real source. I nearly acted on the wrong number.
const inFlight = new Set<string>()

function resolve(item: string, want: number, depth = 0) {
  if (depth > 12) return
  const have = avail[item] ?? (avail[item] = stock(item))
  const fromStock = Math.min(have, want)
  avail[item] -= fromStock
  if (fromStock) used[item] = (used[item] || 0) + fromStock
  let rem = want - fromStock
  if (rem <= 0) return
  const a = ask[item]
  const makers = Object.entries(recs).filter(([, v]: any) => (v.outputs || []).some((o: any) => o.item_id === item)) as [string, any][]
  // Prefer buying when the market can actually cover it at depth.
  if (a && a[1] >= rem) { buy[item] = (buy[item] || 0) + rem; return }
  if (!makers.length) { mine[item] = (mine[item] || 0) + rem; return }
  // Only recipes that do not close a loop back onto something above us.
  const usable = makers.filter(([, v]: any) => !(v.inputs || []).some((i: any) => inFlight.has(i.item_id) || i.item_id === item))
  if (!usable.length) { mine[item] = (mine[item] || 0) + rem; return }
  // Pick the recipe whose facility we already have, else the first.
  let pick = usable.find(([, v]) => (v.produced_by_facility_ids || []).some((f: string) => knownFac.has(f))) || makers[0]
  const [rid, v] = pick
  const outq = (v.outputs || []).filter((o: any) => o.item_id === item).reduce((s: number, o: any) => s + o.quantity, 0) || 1
  const runs = Math.ceil(rem / outq)
  // A recipe listing facilities is NOT the same as a recipe REQUIRING one.
  // draw_silver_wire, draw_gold_wire and assemble_control_node all name facilities
  // AND are hand_craftable:true — reporting them as "[BUILD] 97,000cr" nearly bought
  // a silver_wire_drawing_mill we never needed (2026-09-16). Only a facility_only
  // recipe actually gates anything.
  const fids: string[] = (v.hand_craftable === true) ? [] : (v.produced_by_facility_ids || [])
  if (fids.length) {
    const haveIt = fids.some(f => knownFac.has(f))
    const opts = fids.map(f => facs[f]).filter(Boolean).sort((x: any, y: any) => (x.build_cost || 0) - (y.build_cost || 0))
    if (!facNeeded.has(item)) facNeeded.set(item, { recipe: rid, have: haveIt, cheapest: opts[0]?.id || fids[0], cost: opts[0]?.build_cost || 0 })
  }
  need[item] = (need[item] || 0) + rem
  inFlight.add(item)
  for (const i of (v.inputs || [])) resolve(i.item_id, i.quantity * runs, depth + 1)
  inFlight.delete(item)
}
resolve(target, qty)

console.log(`=== ${qty} x ${target} — RESOLVED TO RAW ===\n`)
console.log('FROM STOCK (already ours):')
for (const [k, q] of Object.entries(used).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${q}`)
let bt = 0
console.log('\nBUY (market has the depth):')
for (const [k, q] of Object.entries(buy).sort((a, b) => b[1] - a[1])) { const a = ask[k]; const c = a ? a[0] * q : 0; bt += c
  console.log(`   ${k.padEnd(28)} ${String(q).padStart(6)} @ ${String(a?.[0] ?? '?').padStart(6)} = ${c.toLocaleString().padStart(11)}  (${a?.[2]})`) }
console.log(`   ${'SUBTOTAL'.padEnd(28)} ${' '.repeat(19)}${bt.toLocaleString()}`)
console.log('\nMINE or otherwise source (no recipe, no market depth):')
for (const [k, q] of Object.entries(mine).sort((a, b) => b[1] - a[1])) {
  const a = ask[k]
  console.log(`   ${k.padEnd(28)} ${String(q).padStart(6)}  ${a ? `market has only ${a[1]} @ ${a[0]}` : 'NOT SOLD — must mine/craft'}`) }
let ft = 0
console.log('\nFACILITIES REQUIRED:')
for (const [item, f] of facNeeded) { if (!f.have) ft += f.cost
  console.log(`   ${(f.have ? '[have] ' : '[BUILD]').padEnd(8)} ${item.padEnd(26)} ${f.cheapest.padEnd(34)} ${f.have ? '' : f.cost.toLocaleString() + 'cr'}`) }
console.log(`\n   facility build subtotal: ${ft.toLocaleString()}cr`)
console.log(`   market subtotal        : ${bt.toLocaleString()}cr`)
console.log(`   TOTAL (excl. facility materials): ${(ft + bt).toLocaleString()}cr`)
