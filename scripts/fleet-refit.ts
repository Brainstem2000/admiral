/**
 * Fleet refit planner — what module upgrade each ship can actually take.
 *
 * Answers the question that keeps getting answered wrong by eye: for THIS hull,
 * with THIS fit, which catalog module is a real improvement that still fits the
 * cpu/power budget after the swap. Three traps it encodes:
 *  - A slot you cannot power is not a slot. Budget = free + what the swapped-out
 *    module returns.
 *  - `special` is role-critical. gas_harvesting only harvests gas; a mining_laser
 *    with more raw mining_power is a DOWNGRADE for a gas specialist.
 *    `common_only` (strip miners) only takes common ore — iron 5cr, copper 8cr —
 *    so raw mining_power is not the ranking either.
 *  - Skill gates: required_skills must be met by that agent.
 *  - A module that costs SPEED can be unflyable. armor_plate_i carries
 *    speed_penalty 1 and is the cheapest defense module at 1cpu/0pwr, so on a
 *    cpu-starved hull it is the only thing that fits — and Ledger's Siege
 *    Breaker has speed 1, where one plate means speed 0.
 *
 * PRICES COME FROM THE BOARD, NOT THE CATALOG. base_value is what a thing is
 * notionally worth, not what anyone will sell it for. Quoting it recommended
 * mining_laser_iv at "~25,000cr" and mining_laser_v at "~55,000cr" on
 * 2026-09-05; both have NO seller on any board in the galaxy and are craft-only,
 * and the Laser III the fleet actually bought cost 19,958 against a 7,900 base.
 * Every line now prices from fleet_intel_market's per-station ask WITH depth, or
 * says plainly that it cannot be bought. Note a station ask is not an empire
 * ask: the crimson aggregate read 15,033 for mining_laser_iii the same hour the
 * Crimson War Citadel board had zero sellers.
 *
 * Usage: bun scripts/fleet-refit.ts
 */
import { Database } from 'bun:sqlite'
import { score, harvests, costsTooMuchSpeed, priceLabel, askFromRow, planFills } from '../src/server/lib/refit-scoring'

const API = 'http://127.0.0.1:3031'
const db = new Database('data/admiral.db', { readonly: true })
const cat = JSON.parse(await Bun.file('data/catalog-cache.json').text())
const rawItems = cat.items
const ITEMS: Record<string, any> = Array.isArray(rawItems)
  ? Object.fromEntries(rawItems.filter((x: any) => x?.id).map((x: any) => [x.id, x]))
  : rawItems

const fleetHas = (id: string) =>
  (db.query('SELECT COALESCE(SUM(quantity),0) q FROM storage_inventory WHERE item_id=?').get(id) as any).q

/** Cheapest per-STATION ask that actually has depth behind it, with its age.
 *  A row with best_sell_qty 0 is not an offer — it is a board with no sellers,
 *  which is exactly how mining_laser_iv and _v present. */
const askQ = db.query(
  `SELECT station_id, best_sell, best_sell_qty, updated_at FROM fleet_intel_market
    WHERE item_id = ? AND best_sell > 0 AND COALESCE(best_sell_qty,0) > 0
    ORDER BY best_sell ASC LIMIT 1`)
const marketAsk = (itemId: string) => askFromRow(askQ.get(itemId))

const profiles = await (await fetch(`${API}/api/profiles`)).json() as any[]
const out: string[] = []
let spend = 0
/** Recommendations with no seller anywhere — reported separately so a total
 *  cost figure never quietly omits the lines it could not price. */
const unpriced: string[] = []

for (const p of profiles.sort((a, b) => a.name.localeCompare(b.name))) {
  const name = p.name.split(' - ')[0]
  let r: any
  try { r = await (await fetch(`${API}/api/profiles/${p.id}/ship-analysis`)).json() } catch { continue }
  if (!r?.ship) continue
  const mods: any[] = r.modules ?? []
  const isGas = mods.some(m => (m.stats?.special ?? m.special) === 'gas_harvesting')
  const role = isGas ? 'gas' : 'ore'

  // skills, for required_skills gating
  const skills: Record<string, number> = {}
  try {
    const sk = await (await fetch(`${API}/api/profiles/${p.id}/skills`)).json()
    for (const v of Object.values(sk.skills ?? {}) as any[]) skills[String(v.name).toLowerCase()] = v.level
  } catch { /* gate on nothing if unreadable */ }

  const cpuFree = r.budgets.cpu_free, pwrFree = r.budgets.power_free
  // Running budget for the FILL loop: each slot filled spends it down.
  let cpuBudget = cpuFree, pwrBudget = pwrFree
  const shipSpeed = Number(r.ship.speed ?? r.ship.operational_speed ?? 0)
  const openBySlot: Record<string, number> = {}
  for (const s of r.open_slots ?? []) openBySlot[s.slot] = s.open

  const lines: string[] = []
  // Consider filling an OPEN slot first (pure gain, nothing sacrificed), then swaps.
  for (const slot of ['weapon', 'defense', 'utility']) {
    const cands = Object.values(ITEMS).filter((m: any) =>
      m?.slot === slot && (m.cpu_usage != null) &&
      Object.entries(m.required_skills ?? {}).every(([k, v]) => (skills[k] ?? 0) >= Number(v)))

    // Fill EVERY open slot of this type, not just one. Ledger had two empty
    // defense slots on 2026-09-05 and got a single suggestion; the second slot
    // stayed empty because nothing ever mentioned it. Budget is spent down as
    // each slot is filled, so the last recommendation is still affordable.
    const { picks, left } = planFills(
      cands, openBySlot[slot] ?? 0, { cpu: cpuBudget, power: pwrBudget }, role, shipSpeed)
    for (const m of picks) {
      const held = fleetHas(m.id), ask = marketAsk(m.id)
      lines.push(`    FILL  ${slot.padEnd(7)} open slot -> ${String(m.id).padEnd(24)} (${m.cpu_usage}cpu/${m.power_usage}pwr)  ${priceLabel(held, ask)}`)
      if (!held && ask) spend += ask.ask
      if (!held && !ask) unpriced.push(`${name}: ${m.id}`)
    }
    cpuBudget = left.cpu; pwrBudget = left.power
    // swap the weakest fitted module in this slot
    const fitted = mods.filter(m => m.slot === slot)
    if (!fitted.length) continue
    fitted.sort((a, b) => score(a, role) - score(b, role))
    const weak = fitted[0]
    const bc = cpuFree + (weak.cpu_usage ?? 0), bp = pwrFree + (weak.power_usage ?? 0)
    // Never remove the LAST harvesting module from a rig that earns by harvesting —
    // that is a capability loss dressed up as an upgrade.
    const harvesters = fitted.filter(f => harvests(f, role)).length
    const wouldStrip = harvests(weak, role) && harvesters === 1
    const better = cands.filter((m: any) =>
      m.cpu_usage <= bc && m.power_usage <= bp && score(m, role) > score(weak, role)
      && (!wouldStrip || harvests(m, role))
      && !costsTooMuchSpeed(m, shipSpeed))
    better.sort((a: any, b: any) => score(b, role) - score(a, role))
    if (better[0]) {
      const m = better[0]
      const held = fleetHas(m.id), ask = marketAsk(m.id)
      lines.push(`    SWAP  ${slot.padEnd(7)} ${String(weak.type_id).padEnd(22)} -> ${String(m.id).padEnd(24)} (${m.cpu_usage}cpu/${m.power_usage}pwr of ${bc}/${bp})  ${priceLabel(held, ask)}`)
      if (!held && ask) spend += ask.ask
      if (!held && !ask) unpriced.push(`${name}: ${m.id}`)
    }
  }
  out.push(`  ${name} — ${r.ship.class_id} (${role} rig, cpu ${r.ship.cpu_used}/${r.ship.cpu_capacity}, pwr ${r.ship.power_used}/${r.ship.power_capacity})`)
  out.push(...(lines.length ? lines : ['    (already optimal for its cpu/power budget)']))
}

console.log('=== FLEET REFIT PLAN ===')
console.log(out.join('\n'))
console.log(`\n  cost of the purchasable lines, at the cheapest per-station ask with depth: ${spend.toLocaleString()}cr`)
if (unpriced.length) {
  console.log(`  NOT PRICED — no seller on any board (craft or source these, do not budget for them):`)
  for (const u of unpriced) console.log(`    ${u}`)
}
