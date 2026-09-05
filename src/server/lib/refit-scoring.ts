/**
 * Scoring and guard rules for the fleet refit planner (`scripts/fleet-refit.ts`).
 *
 * Extracted from the script so the rules can be tested without the script's
 * top-level fetches and database reads. The planner is the only consumer.
 */

/** Comparable "value" of a module within its slot family, role-aware. */
export function score(m: any, role: string): number {
  const s = m.stats ?? m
  if (m.slot === 'weapon') return Number(m.damage ?? s.damage ?? 0)
  // hull_bonus was omitted, so hull_reinforcement_i (+25 hull) scored 0 and could
  // never be recommended even into an empty slot.
  if (m.slot === 'defense') return Number(s.shield_bonus ?? m.shield_bonus ?? 0)
    + Number(s.armor_bonus ?? m.armor_bonus ?? 0)
    + Number(s.hull_bonus ?? m.hull_bonus ?? 0) * 0.4
  const mp = Number(m.mining_power ?? s.mining_power ?? 0)
  if (mp) {
    // Strip miners advertise the highest mining_power in the game (80) and are
    // `common_only` — iron at 5cr, copper at 8cr. Raw mining_power is not the
    // ranking, so they are discounted rather than trusted.
    if (m.special === 'common_only') return mp * 0.15
    if (m.special === 'gas_harvesting') return role === 'gas' ? mp * 3 : 0
    return role === 'gas' ? 0 : mp * 3
  }
  return Number(s.cargo_bonus ?? m.cargo_bonus ?? 0) * 0.2 + Number(s.speed_bonus ?? m.speed_bonus ?? 0) * 6
}

/** Does this module harvest for the given role? */
export function harvests(m: any, role: string): boolean {
  const mp = Number(m.mining_power ?? m.stats?.mining_power ?? 0)
  if (!mp) return false
  const sp = m.special ?? m.stats?.special
  return role === 'gas' ? sp === 'gas_harvesting' : sp !== 'gas_harvesting'
}

/** An armor plate that takes a slow hull to a standstill is not an upgrade.
 *
 *  armor_plate_i carries speed_penalty 1 and is the cheapest defense module in
 *  the game at 1cpu/0pwr, so on a cpu-starved hull it is the only thing that
 *  fits an open slot. Ledger's Siege Breaker has speed 1 — one plate is speed 0.
 *  Returns true when the module must not be recommended for this hull. */
export function costsTooMuchSpeed(m: any, shipSpeed: number): boolean {
  const pen = Number(m.speed_penalty ?? m.stats?.speed_penalty ?? 0)
  return pen > 0 && shipSpeed - pen <= 0
}

export interface MarketAsk { station: string; ask: number; depth: number; ageDays: number }

/** What a recommendation costs, in words. Never invents a price.
 *
 *  base_value is what a thing is notionally worth, not what anyone will sell it
 *  for. Quoting it recommended mining_laser_iv at "~25,000cr" and mining_laser_v
 *  at "~55,000cr" on 2026-09-05; neither has a seller on any board. */
export function priceLabel(held: number, ask: MarketAsk | null): string {
  if (held) return `fleet holds ${held}`
  if (!ask) return `CRAFT-ONLY — no seller on any board`
  const stale = ask.ageDays > 3 ? `, ${Math.floor(ask.ageDays)}d stale` : ''
  return `${ask.ask.toLocaleString()}cr at ${ask.station} (depth ${ask.depth}${stale})`
}

/** Turn a fleet_intel_market row into an ask, or null when the board has no
 *  sellers. A row with best_sell_qty 0 is not an offer. */
export function askFromRow(row: any, now = Date.now()): MarketAsk | null {
  if (!row) return null
  if (!(row.best_sell > 0) || !(row.best_sell_qty > 0)) return null
  const ageDays = (now - Date.parse(String(row.updated_at).replace(' ', 'T') + 'Z')) / 86_400_000
  return { station: row.station_id, ask: row.best_sell, depth: row.best_sell_qty, ageDays }
}

export interface Budget { cpu: number; power: number }

/**
 * Choose a module for EVERY open slot of one type, spending the shared cpu/power
 * budget down as it goes.
 *
 * The planner used to emit one suggestion per slot TYPE regardless of how many
 * slots were open. On 2026-09-05 Ledger Voss had two empty defense slots and got
 * a single shield_booster_i line; the second slot was never mentioned, so it
 * stayed empty. Budget is decremented after each pick so the last recommendation
 * is still one the hull can actually power.
 *
 * Returns the picks plus the budget left, which the caller carries into the next
 * slot type — cpu and power are one pool across the whole ship.
 */
export function planFills(
  cands: any[], openCount: number, budget: Budget, role: string, shipSpeed: number,
): { picks: any[]; left: Budget } {
  const picks: any[] = []
  let { cpu, power } = budget
  for (let i = 0; i < openCount; i++) {
    const fits = cands.filter(m =>
      m.cpu_usage <= cpu && m.power_usage <= power
      && score(m, role) > 0 && !costsTooMuchSpeed(m, shipSpeed))
    fits.sort((a, b) => score(b, role) - score(a, role))
    const m = fits[0]
    if (!m) break            // nothing left that fits — stop, do not pad the list
    picks.push(m)
    cpu -= m.cpu_usage
    power -= m.power_usage
  }
  return { picks, left: { cpu, power } }
}
