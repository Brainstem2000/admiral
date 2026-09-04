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
 *
 * Usage: bun scripts/fleet-refit.ts
 */
import { Database } from 'bun:sqlite'

const API = 'http://127.0.0.1:3031'
const db = new Database('data/admiral.db', { readonly: true })
const cat = JSON.parse(await Bun.file('data/catalog-cache.json').text())
const rawItems = cat.items
const ITEMS: Record<string, any> = Array.isArray(rawItems)
  ? Object.fromEntries(rawItems.filter((x: any) => x?.id).map((x: any) => [x.id, x]))
  : rawItems

const fleetHas = (id: string) =>
  (db.query('SELECT COALESCE(SUM(quantity),0) q FROM storage_inventory WHERE item_id=?').get(id) as any).q

/** Comparable "value" of a module within its slot family, role-aware.
 *
 *  Harvest power is weighted well above speed for a mining rig. An earlier
 *  weighting scored a +4 plasma_afterburner (40) level with a 40-power
 *  mining_laser_iv, so the planner proposed swapping miners' ONLY laser out for
 *  an afterburner — stripping the earning capability it was asked to upgrade.
 *  Speed matters for fleeing and for haulers; it is not what a miner is paid for. */
function score(m: any, role: string): number {
  const s = m.stats ?? m
  if (m.slot === 'weapon') return Number(m.damage ?? s.damage ?? 0)
  if (m.slot === 'defense') return Number(s.shield_bonus ?? m.shield_bonus ?? 0) + Number(s.armor_bonus ?? m.armor_bonus ?? 0)
  const mp = Number(m.mining_power ?? s.mining_power ?? 0)
  if (mp) {
    if (m.special === 'common_only') return mp * 0.15          // common ore is near-worthless
    if (m.special === 'gas_harvesting') return role === 'gas' ? mp * 3 : 0
    return role === 'gas' ? 0 : mp * 3                          // ore laser is useless to a gas rig
  }
  return Number(s.cargo_bonus ?? m.cargo_bonus ?? 0) * 0.2 + Number(s.speed_bonus ?? m.speed_bonus ?? 0) * 6
}

/** Does this module harvest for the given role? */
function harvests(m: any, role: string): boolean {
  const mp = Number(m.mining_power ?? m.stats?.mining_power ?? 0)
  if (!mp) return false
  const sp = m.special ?? m.stats?.special
  return role === 'gas' ? sp === 'gas_harvesting' : sp !== 'gas_harvesting'
}

const profiles = await (await fetch(`${API}/api/profiles`)).json() as any[]
const out: string[] = []
let spend = 0

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
  const openBySlot: Record<string, number> = {}
  for (const s of r.open_slots ?? []) openBySlot[s.slot] = s.open

  const lines: string[] = []
  // Consider filling an OPEN slot first (pure gain, nothing sacrificed), then swaps.
  for (const slot of ['weapon', 'defense', 'utility']) {
    const cands = Object.values(ITEMS).filter((m: any) =>
      m?.slot === slot && (m.cpu_usage != null) &&
      Object.entries(m.required_skills ?? {}).every(([k, v]) => (skills[k] ?? 0) >= Number(v)))

    if ((openBySlot[slot] ?? 0) > 0) {
      const fits = cands.filter((m: any) => m.cpu_usage <= cpuFree && m.power_usage <= pwrFree && score(m, role) > 0)
      fits.sort((a: any, b: any) => score(b, role) - score(a, role))
      if (fits[0]) {
        const m = fits[0]
        lines.push(`    FILL  ${slot.padEnd(7)} open slot -> ${String(m.id).padEnd(24)} (${m.cpu_usage}cpu/${m.power_usage}pwr)  ${fleetHas(m.id) ? `fleet holds ${fleetHas(m.id)}` : `~${(m.base_value ?? 0).toLocaleString()}cr`}`)
        if (!fleetHas(m.id)) spend += m.base_value ?? 0
      }
    }
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
      && (!wouldStrip || harvests(m, role)))
    better.sort((a: any, b: any) => score(b, role) - score(a, role))
    if (better[0]) {
      const m = better[0]
      const held = fleetHas(m.id)
      lines.push(`    SWAP  ${slot.padEnd(7)} ${String(weak.type_id).padEnd(22)} -> ${String(m.id).padEnd(24)} (${m.cpu_usage}cpu/${m.power_usage}pwr of ${bc}/${bp})  ${held ? `fleet holds ${held}` : `~${(m.base_value ?? 0).toLocaleString()}cr`}`)
      if (!held) spend += m.base_value ?? 0
    }
  }
  out.push(`  ${name} — ${r.ship.class_id} (${role} rig, cpu ${r.ship.cpu_used}/${r.ship.cpu_capacity}, pwr ${r.ship.power_used}/${r.ship.power_capacity})`)
  out.push(...(lines.length ? lines : ['    (already optimal for its cpu/power budget)']))
}

console.log('=== FLEET REFIT PLAN ===')
console.log(out.join('\n'))
console.log(`\n  estimated purchase cost of everything not already in fleet storage: ~${spend.toLocaleString()}cr`)
