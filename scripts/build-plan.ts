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
const allItems: any[] = Array.isArray(cat.items) ? cat.items : Object.values(cat.items ?? {})
const itemById = new Map<string, any>(allItems.filter(i => i?.id).map(i => [i.id, i]))
/** How a raw is actually pulled out of the ground. Getting this wrong sent two
 *  miners to a uranium belt with Mining Laser IIIs: uranium_ore is
 *  `extracted_by: rad` and needs a Rad Harvester, a different utility module
 *  entirely. "Mine it" is not an instruction until you know which tool. */
const EXTRACTOR: Record<string, string> = {
  rad: 'rad_harvester_*  (radioactive deposits — a mining laser will NOT pull this)',
  gas: 'gas_harvester_*  (gas clouds)',
  ice: 'ice_harvester_*  (ice fields)',
  mining: 'mining_laser_*  (asteroid belts)',
}
function howToGet(id: string): string {
  const by = itemById.get(id)?.extracted_by
  if (by) return `${by} — fit ${EXTRACTOR[by] ?? by + '_harvester'}`
  return 'not extractable — hunted, salvaged or a drop'
}
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

// SCOPE. `SUM(quantity)` over the whole table answers "does the fleet own this
// somewhere", which is NOT the question a build asks. Storage is per-agent AND
// per-station: you can only withdraw YOUR goods at the station you are docked at.
// Unscoped, this script reported the Juggernaut as "BUY subtotal 0" while the
// agent tasked with building it held 0 of 180 circuit_board, 0 of 491 silicon_ore
// and 24 of 6,902 fury_crystal — every one of them someone else's, most of them
// belonging to agents who are docked and offline. The same summing error sent
// Rook Vance to War Citadel for "13 free rad_harvester_i" he could not touch.
//   --for <agent>      count only that agent's storage (name prefix, case-insensitive)
//   --at <station_id>  count only that station
//   --faction          also count the faction lockbox (faction_storage_inventory)
// Default stays fleet-wide, which is the right frame for "can the fleet do this
// at all" — but the header says which frame is in force, because a bare number
// with no frame is how this went wrong every previous time.
const argOf = (flag: string): string | null => {
  const i = Bun.argv.indexOf(flag)
  return i > 0 && Bun.argv[i + 1] ? Bun.argv[i + 1] : null
}
const forAgent = argOf('--for')
const atStation = argOf('--at')

let scopeProfileId: string | null = null
let scopeAgentName: string | null = null
if (forAgent) {
  const row = db.query('SELECT id, name FROM profiles WHERE lower(name) LIKE ?')
                .get(forAgent.toLowerCase() + '%') as any
  if (!row) { console.error(`no such agent: ${forAgent}`); process.exit(1) }
  scopeProfileId = row.id
  scopeAgentName = row.name
}

const where = ['item_id = ?']
const bindExtra: string[] = []
if (scopeProfileId) { where.push('profile_id = ?'); bindExtra.push(scopeProfileId) }
if (atStation) { where.push('station_id = ?'); bindExtra.push(atStation) }
const stockQ = db.query(
  `SELECT COALESCE(SUM(quantity),0) q FROM storage_inventory WHERE ${where.join(' AND ')}`)
// --faction: the faction lockbox (faction_storage_inventory, fed by `view target=faction`)
// may SUPPLY a line — an officer pulls it with withdraw(source=faction, target=self) —
// but it is never "delivered": the yard draws from the agent's own storage. So the
// lockbox is reported in its own column and counted only as a source for the gap.
// The Juggernaut count on 2026-09-10 missed shield_emitter 172, hull_plating 195,
// durasteel_plate 221 and weapon_housing 80 sitting in the War Citadel lockbox.
const withFaction = process.argv.includes('--faction')
const factionQ = db.query(
  `SELECT COALESCE(SUM(quantity),0) q FROM faction_storage_inventory WHERE item_id = ?${atStation ? ' AND station_id = ?' : ''}`)
/** The agent's own storage in scope (never the lockbox). */
const heldCache = new Map<string, number>()
const held = (id: string) => {
  if (!heldCache.has(id)) heldCache.set(id, (stockQ.get(id, ...bindExtra) as any).q as number)
  return heldCache.get(id)!
}
/** Lockbox units in scope — at the yard when --at is given, else across every station. */
const lockboxCache = new Map<string, number>()
const lockbox = (id: string) => {
  if (!lockboxCache.has(id)) lockboxCache.set(id, (factionQ.get(...(atStation ? [id, atStation] : [id])) as any).q as number)
  return lockboxCache.get(id)!
}
/** What the resolver may draw on: own storage, plus the lockbox when --faction says an officer will pull it. */
const stock = (id: string) => held(id) + (withFaction ? lockbox(id) : 0)

/** Rough cost of obtaining `qty` of `id`, used only to CHOOSE between recipes. */
/** Price of a unit nobody sells, nobody can mine, and no recipe makes: only a hunt or a wreck yields it. */
const DROP_PENALTY_PER_UNIT = 250_000

// Stock is consumed as the plan commits it. Without reservation the same units
// satisfied every node that asked: the 8 reactor_fuel_assembly in the lockbox
// covered the plutonium line AND fed a wrap_/unwrap_ cycle that then priced as
// free, and any two branches leaning on one steel_plate stack were both "covered".
const reserved = new Map<string, number>()
function avail(id: string, path?: Map<string, number>): number {
  return Math.max(0, stock(id) - (reserved.get(id) ?? 0) - (path?.get(id) ?? 0))
}
function withUse(path: Map<string, number> | undefined, id: string, use: number): Map<string, number> {
  const m = new Map(path ?? []); if (use > 0) m.set(id, (m.get(id) ?? 0) + use); return m
}

function cost(id: string, qty: number, seen = new Set<string>(), path?: Map<string, number>): number {
  const use = Math.min(qty, avail(id, path))
  const net = Math.max(0, qty - use)
  if (net === 0) return 0
  const nextPath = withUse(path, id, use)
  // Buying COMPETES with crafting — it does not pre-empt it. Preferring a
  // purchase the moment depth allowed bought fury_alloy x96 for 1,920,000
  // while 6,270 fury_crystal sat in storage and the craft cost nothing.
  const sup = supplier(id, net)
  const buyCost = sup ? sup.best_ask * net : Infinity
  // A recipe cycle never yields net units: reaching `id` again while costing
  // one of its own recipes means "buy X to craft X", which is not a chain. The
  // purchase escape belongs one level up — plan() and cost() both compare a
  // direct purchase against every recipe before recursing — so here it must be
  // Infinity. Returning buyCost let wrap_/unwrap_reactor_fuel_assembly price 8
  // assemblies at the market ask and masquerade as a craft (2026-09-10).
  if (seen.has(id)) return Infinity
  const rs = recipesFor(id)
  const next = new Set(seen).add(id)
  // An item with NO recipe is a raw. A raw the fleet can EXTRACT (mining, rad,
  // gas, ice) gets a heavy but finite price; a raw with no extraction type is a
  // drop — hunted, salvaged or looted — and must price far above any chain the
  // fleet can actually run. At a flat 5,000/unit, 16 hoarfrost_heartcore (80,000)
  // beat the fusion route to power_core whose helium the lockbox already held,
  // so the plan told the Admiral on 2026-09-10 to go hunting. An item whose
  // every recipe is cyclic is NOT mineable and must stay Infinity — collapsing
  // that to the same penalty let wrap/unwrap loops price at 5,000/unit and beat
  // the real chain (breed_plutonium).
  if (!rs.length) {
    const by = itemById.get(id)?.extracted_by
    return Math.min(buyCost, net * (by ? 5_000 : DROP_PENALTY_PER_UNIT))
  }
  const craftCost = Math.min(...rs.map(r => {
    const runs = Math.ceil(net / yieldOf(r, id))
    return (r.inputs ?? r.materials ?? []).reduce(
      (s: number, i: any) => s + cost(i.item_id, i.quantity * runs, next, nextPath), 0)
  }))
  return Math.min(buyCost, craftCost)
}

const buy = new Map<string, number>(), mine = new Map<string, number>(), make = new Map<string, string>()
function plan(id: string, qty: number, seen = new Set<string>()) {
  const use = Math.min(qty, avail(id))
  if (use > 0) reserved.set(id, (reserved.get(id) ?? 0) + use)
  const net = Math.max(0, qty - use)
  if (net === 0) return
  const sup = supplier(id, net)
  const buyCost = sup ? sup.best_ask * net : Infinity
  const next = new Set(seen).add(id)
  const priced = (seen.has(id) ? [] : recipesFor(id)).map(r => ({
    r,
    c: (r.inputs ?? r.materials ?? []).reduce((s: number, i: any) =>
      s + cost(i.item_id, i.quantity * Math.ceil(net / yieldOf(r, id)), next, new Map([[id, use]])), 0),
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

const hullArg = Bun.argv.slice(2).find(a => !a.startsWith('--')
  && a !== forAgent && a !== atStation)
const hull = ships.find(s => s.id === hullArg)
if (!hull) { console.error(`no such hull: ${hullArg}`); process.exit(1) }

// THE LINES. The yard's own list is the hull's build_materials (authoritative per
// the codex). Rows recorded in commission_requirements for this class that are not
// yard lines (chain intermediates the Admiral chose to track) are appended and
// flagged, so nothing the fleet committed to disappears from the report.
const yardLines: Array<{ item_id: string; quantity: number; recorded: boolean }> =
  (hull.build_materials ?? []).map((m: any) => ({ item_id: m.item_id, quantity: m.quantity, recorded: false }))
const recordedRows = db.query('SELECT item_id, quantity FROM commission_requirements WHERE ship_class = ? ORDER BY item_id')
  .all(hull.id) as Array<{ item_id: string; quantity: number }>
for (const r of recordedRows) if (!yardLines.some(l => l.item_id === r.item_id)) yardLines.push({ item_id: r.item_id, quantity: r.quantity, recorded: true })

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const scopeLabel = scopeAgentName
  ? `stock counted: ${scopeAgentName} only${atStation ? ` at ${atStation}` : ' across ALL stations'}${withFaction ? `; lockbox${atStation ? ` at ${atStation}` : ' at every station'} shown separately and usable as a source` : ''}`
  : atStation
    ? `stock counted: all agents at ${atStation}`
    : 'stock counted: FLEET-WIDE across every agent and station — '
      + 'a build needs it in ONE hold at ONE yard, so re-run with --for <agent> before tasking anyone'
console.log(`=== ${hull.name} — shipyard tier ${hull.shipyard_tier}, min crew ${hull.minimum_crew} ===`)
console.log(`    ${scopeLabel}`)
if (scopeProfileId && !atStation) {
  // Summing one agent's storage across every station is how this script said
  // "BUY subtotal 0" for the Juggernaut on 2026-09-11: a stale Obsidian Well
  // snapshot still held 5 neutronium the agent had already hauled away, and the
  // Haven lockbox held the targeting computers — none of it at the yard.
  console.log('    WARNING: no yard given — held/lockbox below are summed across every station this agent has a snapshot at.')
  console.log('             A commission draws from ONE station: re-run with --at <station_id> (e.g. --at crimson_war_citadel).')
}
console.log('')

// Per-line: what the yard checks, in the frame that matters (the agent AT the yard).
// The lockbox is its own column and its own source line — it is never "held".
console.log(`YARD LINES (${yardLines.length}${recordedRows.length ? `, ${yardLines.filter(l => l.recorded).length} recorded-only` : ''}):`)
console.log(`  ${'item'.padEnd(26)} ${'need'.padStart(5)} ${'held'.padStart(5)} ${'lockbox'.padStart(7)} ${'gap'.padStart(5)}  source of the gap`)
for (const line of yardLines) {
  const need = line.quantity
  const own = Math.min(need, Math.max(0, held(line.item_id) - (reserved.get(line.item_id) ?? 0)))
  const box = lockbox(line.item_id)
  const gap = need - own
  let source = ''
  if (gap === 0) source = 'covered'
  else {
    const pull = withFaction ? Math.min(gap, Math.max(0, box - Math.max(0, (reserved.get(line.item_id) ?? 0) - held(line.item_id)))) : 0
    const rest = gap - pull
    const before = { buy: buy.get(line.item_id) ?? 0, mine: mine.get(line.item_id) ?? 0, make: make.get(line.item_id)?.qty ?? 0 }
    plan(line.item_id, need)                   // reserves own stock (+ lockbox when --faction), resolves the rest
    const d = {
      buy: (buy.get(line.item_id) ?? 0) - before.buy, mine: (mine.get(line.item_id) ?? 0) - before.mine,
      make: (make.get(line.item_id)?.qty ?? 0) - before.make,
    }
    const parts: string[] = []
    if (pull > 0) parts.push(`LOCKBOX pull ${pull} (withdraw source=faction target=self)`)
    if (d.buy > 0) { const s = supplier(line.item_id, d.buy); parts.push(`BUY ${d.buy} @${n(s?.best_ask ?? ask(line.item_id))} in ${s?.empire ?? '?'} (depth ${s?.ask_quantity_at_best ?? depth(line.item_id)})`) }
    if (d.make > 0) parts.push(`CRAFT ${d.make} via ${[...(make.get(line.item_id)?.rids ?? [])].join(' | ')}`)
    if (d.mine > 0) parts.push(`GATHER ${d.mine}: ${howToGet(line.item_id)}`)
    if (!parts.length && rest > 0) parts.push(`unresolved ${rest}`)
    source = parts.join('; ')
  }
  console.log(`  ${(line.item_id + (line.recorded ? ' (recorded)' : '')).padEnd(26)} ${String(need).padStart(5)} ${String(own).padStart(5)} ${(box ? String(box) : '-').padStart(7)} ${String(gap).padStart(5)}  ${source}`)
}
console.log('')
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
for (const [id, q] of [...mine].sort((a, b) => b[1] - a[1])) {
  const sup2 = offers(id).sort((a, b) => a.best_ask - b.best_ask)[0]
  console.log(`  ${id.padEnd(24)} ${String(q).padStart(5)}   ${sup2 ? `best ask ${n(sup2.best_ask)} in ${sup2.empire} but depth only ${sup2.ask_quantity_at_best}` : 'no ask in any empire'}`)
  console.log(`  ${' '.repeat(24)}         ${howToGet(id)}`)
}
console.log(`\nCRAFT (${make.size} steps, cheapest recipe chosen per item):`)
for (const [id, m] of make) console.log(`  ${id.padEnd(24)} x${String(m.qty).padStart(4)}  via ${[...m.rids].join(' | ')}`)
