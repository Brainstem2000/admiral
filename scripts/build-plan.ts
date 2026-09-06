/**
 * build-plan — what a hull ACTUALLY costs, resolved to raw inputs, cheapest path.
 *
 *   bun scripts/build-plan.ts crimson_devastator
 *
 * Exists because two other tools each got this wrong in a way that changed the
 * answer by an order of magnitude:
 *
 * - `ship-match.ts <agent> <hull>` totals at the HEADLINE ask while most lines
 *   are ask-depth 1. It priced fury_alloy x96 at 312,480cr; War Citadel already
 *   held 6,270 fury_crystal against the 288 the craft needs.
 * - A first cut of this script ignored `output_quantity` (a recipe yielding 2 or
 *   3 per craft needs proportionally fewer runs), inflating uranium_ore from 805
 *   to 1,687 — and, worse, took the FIRST recipe for each item. Several items
 *   have many: `focused_crystal` has 3 and `titanium_alloy` has 6. Picking first
 *   made the Devastator look like it needed a druse ranch (raw_focusing_crystal
 *   x380) and 252 anchor_plate, when `focus_energy_crystal` and
 *   `forge_titanium_alloy` avoid both entirely.
 *
 * So: for every item, try EVERY recipe and keep the one whose resolved inputs the
 * fleet can most nearly satisfy from stock plus real market depth. Buy only where
 * `ask_quantity_at_best` actually covers the quantity.
 */
import { Database } from 'bun:sqlite'

/** Cache to disk: the feeds 502 intermittently, and a null catalog is a confusing crash. */
async function feed(url: string, name: string, maxAgeMs = 30 * 60_000): Promise<any> {
  const path = `data/.cache/${name}`
  try {
    const f = Bun.file(path)
    if (await f.exists() && Date.now() - (await f.stat()).mtimeMs < maxAgeMs) return JSON.parse(await f.text())
  } catch { /* refetch */ }
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`${res.status}`)
      const text = await res.text()
      const parsed = JSON.parse(text)
      if (parsed) { await Bun.write(path, text); return parsed }
    } catch { await new Promise(r => setTimeout(r, 1500 * a)) }
  }
  const f = Bun.file(path)                      // stale beats nothing
  if (await f.exists()) { console.error(`WARNING: ${name} feed unreachable, using cached copy`); return JSON.parse(await f.text()) }
  throw new Error(`${name}: feed unreachable and no cache`)
}
const cat = await feed('https://game.spacemolt.com/api/catalog.json', 'catalog.json')
const mkt = await feed('https://game.spacemolt.com/api/market', 'market.json', 10 * 60_000)
const db = new Database('data/admiral.db', { readonly: true })

const ships: any[] = Array.isArray(cat.ships) ? cat.ships : Object.values(cat.ships)
const recipes: any[] = Array.isArray(cat.recipes) ? cat.recipes : Object.values(cat.recipes)

const outputsOf = (r: any): string[] =>
  r.output_item ? [r.output_item] : (r.outputs ?? []).map((o: any) => o.item_id)
const yieldOf = (r: any, id: string): number =>
  r.output_quantity ?? (r.outputs ?? []).find((o: any) => o.item_id === id)?.quantity ?? 1
const recipesFor = (id: string) => recipes.filter(r => outputsOf(r).includes(id))

// The feed carries ONE ROW PER EMPIRE and prices differ enormously between them
// (power_cell: 4,583 in crimson, 30,900 in nebula). Collapsing by last-write picked
// an arbitrary empire and quoted power_cell at 8,120. Keep the cheapest row that
// actually has depth, and report which empire it is in.
const rows: any[] = Array.isArray(mkt) ? mkt : (mkt.items ?? Object.values(mkt))
const byItem = new Map<string, any[]>()
for (const r of rows) {
  const id = r?.item_id ?? r?.id
  if (id) byItem.set(id, [...(byItem.get(id) ?? []), r])
}
const offers = (id: string) => (byItem.get(id) ?? []).filter(r => r.best_ask > 0)
/** Cheapest empire whose best-ask depth covers `qty`, or null. */
const supplier = (id: string, qty: number) =>
  offers(id).filter(r => (r.ask_quantity_at_best ?? 0) >= qty)
            .sort((a, b) => a.best_ask - b.best_ask)[0] ?? null
const ask = (id: string) => offers(id).sort((a, b) => a.best_ask - b.best_ask)[0]?.best_ask ?? 0
const depth = (id: string) => Math.max(0, ...offers(id).map(r => r.ask_quantity_at_best ?? 0))

const stockQ = db.query('SELECT COALESCE(SUM(quantity),0) q FROM storage_inventory WHERE item_id = ?')
const stockCache = new Map<string, number>()
const stock = (id: string) => {
  if (!stockCache.has(id)) stockCache.set(id, (stockQ.get(id) as any).q as number)
  return stockCache.get(id)!
}

/** Rough cost of obtaining `qty` of `id`, used only to CHOOSE between recipes. */
function cost(id: string, qty: number, seen = new Set<string>()): number {
  const net = Math.max(0, qty - stock(id))
  if (net === 0) return 0
  // Buying COMPETES with crafting — it does not pre-empt it. Preferring a
  // purchase the moment depth allowed bought fury_alloy x96 for 1,920,000
  // while 6,270 fury_crystal sat in storage and the craft cost nothing.
  const sup = supplier(id, net)
  const buyCost = sup ? sup.best_ask * net : Infinity
  if (seen.has(id)) return buyCost                               // recipe cycle: only a purchase escapes it
  const rs = recipesFor(id)
  const next = new Set(seen).add(id)
  // An item with NO recipe is a raw: mineable, so give it a heavy but finite
  // price. An item whose every recipe is cyclic is NOT mineable and must stay
  // Infinity — collapsing that to the same penalty let wrap/unwrap loops price
  // at 5,000/unit and beat the real chain (breed_plutonium).
  if (!rs.length) return Math.min(buyCost, net * 5_000)
  const craftCost = Math.min(...rs.map(r => {
    const runs = Math.ceil(net / yieldOf(r, id))
    return (r.inputs ?? r.materials ?? []).reduce(
      (s: number, i: any) => s + cost(i.item_id, i.quantity * runs, next), 0)
  }))
  return Math.min(buyCost, craftCost)
}

const buy = new Map<string, number>(), mine = new Map<string, number>(), make = new Map<string, string>()
function plan(id: string, qty: number, seen = new Set<string>()) {
  const net = Math.max(0, qty - stock(id))
  if (net === 0) return
  const sup = supplier(id, net)
  const buyCost = sup ? sup.best_ask * net : Infinity
  const next = new Set(seen).add(id)
  const priced = (seen.has(id) ? [] : recipesFor(id)).map(r => ({
    r,
    c: (r.inputs ?? r.materials ?? []).reduce((s: number, i: any) =>
      s + cost(i.item_id, i.quantity * Math.ceil(net / yieldOf(r, id)), next), 0),
  })).filter(x => Number.isFinite(x.c)).sort((a, b) => a.c - b.c)
  if (!priced.length || priced[0].c > buyCost) {
    if (sup) { buy.set(id, (buy.get(id) ?? 0) + net); return }
    mine.set(id, (mine.get(id) ?? 0) + net); return
  }
  const best = priced[0].r
  // An item reached down two branches is planned twice with different `seen` sets,
  // so it can legitimately resolve via different recipes. Record every one — an
  // earlier version kept only the last write and displayed `armor_plate via
  // carapace_plating` while the traversal had actually used forge_armor_plate,
  // which is why creature_carapace never appeared in the gather list.
  const e = make.get(id) ?? { rids: new Set<string>(), qty: 0 }
  e.rids.add(best.id); e.qty += net; make.set(id, e)
  const runs = Math.ceil(net / yieldOf(best, id))
  for (const i of (best.inputs ?? best.materials ?? [])) plan(i.item_id, i.quantity * runs, next)
}

const hull = ships.find(s => s.id === Bun.argv[2])
if (!hull) { console.error(`no such hull: ${Bun.argv[2]}`); process.exit(1) }
for (const m of hull.build_materials) plan(m.item_id, m.quantity)

const n = (x: number) => Math.round(x).toLocaleString('en-US')
console.log(`=== ${hull.name} — shipyard tier ${hull.shipyard_tier}, min crew ${hull.minimum_crew} ===\n`)
let spend = 0
console.log('BUY (market depth actually covers it):')
for (const [id, q] of [...buy].sort((a, b) => ask(b[0]) * b[1] - ask(a[0]) * a[1])) {
  const sup = supplier(id, q) ?? offers(id).sort((a, b) => a.best_ask - b.best_ask)[0]
  const px = sup?.best_ask ?? 0
  spend += px * q
  console.log(`  ${id.padEnd(24)} ${String(q).padStart(5)} @${n(px).padStart(7)} = ${n(px * q).padStart(9)}  in ${sup?.empire ?? '?'} (depth ${sup?.ask_quantity_at_best ?? 0})`)
}
console.log(`  ${'subtotal'.padEnd(24)} ${' '.repeat(5)}  ${' '.repeat(8)} ${n(spend).padStart(9)}\n`)
console.log('MINE / HUNT / GATHER (no seller at the needed quantity):')
for (const [id, q] of [...mine].sort((a, b) => b[1] - a[1]))
  console.log(`  ${id.padEnd(24)} ${String(q).padStart(5)}   ${ask(id) ? `ask ${n(ask(id))} but depth only ${depth(id)}` : 'no ask anywhere'}`)
console.log(`\nCRAFT (${make.size} steps, cheapest recipe chosen per item):`)
for (const [id, m] of make) console.log(`  ${id.padEnd(24)} x${String(m.qty).padStart(4)}  via ${[...m.rids].join(' | ')}`)
