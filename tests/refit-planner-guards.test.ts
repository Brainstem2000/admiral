/**
 * The refit planner recommended things that could not be bought, and had no
 * guard against a module that stops the ship.
 *
 * Found 2026-09-05 while upgrading Ledger Voss's Siege Breaker. The planner
 * offered `mining_laser_iv` at "~25,000cr" and `mining_laser_v` at "~55,000cr".
 * Both figures were the catalog's `base_value`, and neither module has a seller
 * on any board in the galaxy — they are craft-only. The Laser III the fleet did
 * buy that day cost 19,958 against a base_value of 7,900, so base_value is not
 * even the right order of magnitude. A planner that prints a price for an
 * unbuyable module is making the same mistake as quoting a bid without its
 * depth: it reports a number where it should report "you cannot have this".
 *
 * The speed guard is the second half. `armor_plate_i` carries speed_penalty 1
 * and is the cheapest defense module in the game at 1cpu/0pwr, so on a hull with
 * almost no CPU left it is the only thing that fits an open slot. Ledger's Siege
 * Breaker has speed 1 — one plate would have taken it to 0.
 *
 * The `common_only` discount is tested too, not because it was broken, but
 * because it is the rule most likely to be "simplified" away by someone reading
 * mining_power and assuming bigger is better. Strip Miner II shows the highest
 * mining_power in the catalog (80) and only works on iron and copper.
 */
import { test, expect, describe } from 'bun:test'
import { score, harvests, costsTooMuchSpeed, priceLabel, askFromRow, planFills } from '../src/server/lib/refit-scoring'

// Real catalog shapes, copied from data/catalog-cache.json on 2026-09-05.
const MINING_LASER_III = { id: 'mining_laser_iii', slot: 'utility', mining_power: 22, cpu_usage: 6, power_usage: 12, base_value: 7900 }
const MINING_LASER_V   = { id: 'mining_laser_v',   slot: 'utility', mining_power: 70, cpu_usage: 13, power_usage: 24, base_value: 55000 }
const STRIP_MINER_II   = { id: 'strip_miner_ii',   slot: 'utility', mining_power: 80, cpu_usage: 9, power_usage: 32, base_value: 18000, special: 'common_only' }
const GAS_HARVESTER_IV = { id: 'gas_harvester_iv', slot: 'utility', mining_power: 60, cpu_usage: 12, power_usage: 22, special: 'gas_harvesting' }
const ARMOR_PLATE_I    = { id: 'armor_plate_i',    slot: 'defense', armor_bonus: 5, cpu_usage: 1, power_usage: 0, speed_penalty: 1 }
const ARMOR_PLATE_II   = { id: 'armor_plate_ii',   slot: 'defense', armor_bonus: 10, cpu_usage: 2, power_usage: 2, speed_penalty: 1 }
const SHIELD_BOOSTER_I = { id: 'shield_booster_i', slot: 'defense', shield_bonus: 25, cpu_usage: 2, power_usage: 4 }
const HULL_REINF_I     = { id: 'hull_reinforcement_i', slot: 'defense', hull_bonus: 25, cargo_bonus: -5, cpu_usage: 1, power_usage: 0 }

describe('a module that would stop the ship is never recommended', () => {
  test("Ledger's speed-1 Siege Breaker refuses an armor plate", () => {
    expect(costsTooMuchSpeed(ARMOR_PLATE_I, 1)).toBe(true)
    expect(costsTooMuchSpeed(ARMOR_PLATE_II, 1)).toBe(true)
  })

  test('a faster hull may still take one', () => {
    expect(costsTooMuchSpeed(ARMOR_PLATE_I, 4)).toBe(false)
  })

  test('speed exactly reaching zero is still refused, not just going negative', () => {
    // speed 1 with penalty 1 lands on 0 — a ship that cannot move.
    expect(costsTooMuchSpeed({ speed_penalty: 1 }, 1)).toBe(true)
  })

  test('modules with no speed penalty are unaffected on any hull', () => {
    expect(costsTooMuchSpeed(SHIELD_BOOSTER_I, 1)).toBe(false)
    expect(costsTooMuchSpeed(MINING_LASER_III, 1)).toBe(false)
  })

  test('the penalty is read from a nested stats block too', () => {
    expect(costsTooMuchSpeed({ stats: { speed_penalty: 1 } }, 1)).toBe(true)
  })
})

describe('prices come from the board, never from base_value', () => {
  const ASK = { station: 'iron_reach_mining_colony', ask: 19958, depth: 1, ageDays: 0.2 }

  test('a module with no seller is named as such, with no number', () => {
    const label = priceLabel(0, null)
    expect(label).toContain('CRAFT-ONLY')
    // The specific regression: mining_laser_v's 55,000 base_value must not surface.
    expect(label).not.toContain('55,000')
    expect(label).not.toMatch(/\d/)
  })

  test('a real ask reports its station and its depth', () => {
    const label = priceLabel(0, ASK)
    expect(label).toContain('19,958')
    expect(label).toContain('iron_reach_mining_colony')
    expect(label).toContain('depth 1')
  })

  test('a stale reading says so — a six-day-old ask is not a price', () => {
    expect(priceLabel(0, { ...ASK, ageDays: 6.4 })).toContain('6d stale')
    expect(priceLabel(0, ASK)).not.toContain('stale')
  })

  test('stock the fleet already holds outranks any purchase', () => {
    expect(priceLabel(3, ASK)).toBe('fleet holds 3')
  })
})

describe('a board row only counts as an offer when someone is selling', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')

  test('an ask with zero depth is not an offer — this is how Laser IV and V present', () => {
    expect(askFromRow({ station_id: 's', best_sell: 57994, best_sell_qty: 0, updated_at: '2026-09-05 11:00:00' }, now)).toBeNull()
  })

  test('a row with no ask at all is not an offer', () => {
    expect(askFromRow({ station_id: 's', best_sell: 0, best_sell_qty: 12, updated_at: '2026-09-05 11:00:00' }, now)).toBeNull()
    expect(askFromRow(null, now)).toBeNull()
  })

  test('a genuine offer survives, and its age is measured from a SQLite timestamp', () => {
    // SQLite datetimes use a space, not an ISO "T" — parsing that wrong has
    // silently matched nothing before (tests/fleet health, 2026-09-04).
    const a = askFromRow({ station_id: 'sirius_observatory_station', best_sell: 57994, best_sell_qty: 4, updated_at: '2026-09-03 12:00:00' }, now)
    expect(a).not.toBeNull()
    expect(a!.depth).toBe(4)
    expect(Math.round(a!.ageDays)).toBe(2)
  })
})

describe('raw mining_power is not the ranking', () => {
  test('Strip Miner II leads on mining_power and still loses to a Laser V', () => {
    expect(STRIP_MINER_II.mining_power).toBeGreaterThan(MINING_LASER_V.mining_power)
    expect(score(STRIP_MINER_II, 'ore')).toBeLessThan(score(MINING_LASER_V, 'ore'))
  })

  test('it also loses to the far weaker Laser III, because common ore is near-worthless', () => {
    expect(score(STRIP_MINER_II, 'ore')).toBeLessThan(score(MINING_LASER_III, 'ore'))
  })

  test('an ore laser is worthless to a gas rig and vice versa', () => {
    expect(score(MINING_LASER_V, 'gas')).toBe(0)
    expect(score(GAS_HARVESTER_IV, 'ore')).toBe(0)
    expect(score(GAS_HARVESTER_IV, 'gas')).toBeGreaterThan(0)
  })

  test('harvester detection follows the role, so a swap cannot strip the last one', () => {
    expect(harvests(MINING_LASER_III, 'ore')).toBe(true)
    expect(harvests(MINING_LASER_III, 'gas')).toBe(false)
    expect(harvests(GAS_HARVESTER_IV, 'gas')).toBe(true)
    expect(harvests(SHIELD_BOOSTER_I, 'ore')).toBe(false)
  })
})

describe('defense scoring counts every kind of protection', () => {
  test('a hull-reinforcement module is visible, not scored zero', () => {
    // It offers +25 hull and was previously invisible to the planner, so it
    // could never be recommended into an empty slot.
    expect(score(HULL_REINF_I, 'ore')).toBeGreaterThan(0)
  })

  test('a shield booster still outranks it, and both outrank a plate', () => {
    expect(score(SHIELD_BOOSTER_I, 'ore')).toBeGreaterThan(score(HULL_REINF_I, 'ore'))
    expect(score(HULL_REINF_I, 'ore')).toBeGreaterThan(score(ARMOR_PLATE_I, 'ore'))
  })
})

describe('every open slot gets a recommendation, not just the first', () => {
  // Ledger Voss's Siege Breaker as it stood on 2026-09-05 before the refit:
  // 3 utility / 1 weapon / 2 defense, cpu 24, power 60, one Laser III fitted,
  // BOTH defense slots empty. The planner named one shield booster and never
  // mentioned the second slot, so it stayed empty.
  const DEFENSE = [SHIELD_BOOSTER_I, HULL_REINF_I, ARMOR_PLATE_I, ARMOR_PLATE_II]

  test('two empty defense slots produce two picks', () => {
    const { picks } = planFills(DEFENSE, 2, { cpu: 15, power: 44 }, 'ore', 1)
    expect(picks).toHaveLength(2)
  })

  test('neither pick is an armor plate, on a speed-1 hull', () => {
    const { picks } = planFills(DEFENSE, 2, { cpu: 15, power: 44 }, 'ore', 1)
    expect(picks.map(p => p.id)).not.toContain('armor_plate_i')
    expect(picks.map(p => p.id)).not.toContain('armor_plate_ii')
  })

  test('the budget is spent down, so the second pick is still powerable', () => {
    // 3 cpu / 4 power. The booster (2cpu/4pwr) takes the power, leaving 1 cpu and
    // nothing else — only the zero-power hull reinforcement can follow.
    const { picks, left } = planFills(DEFENSE, 2, { cpu: 3, power: 4 }, 'ore', 4)
    expect(picks.map(p => p.id)).toEqual(['shield_booster_i', 'hull_reinforcement_i'])
    expect(left).toEqual({ cpu: 0, power: 0 })
  })

  test('it stops rather than padding when nothing else fits', () => {
    // 2 cpu / 4 power is exactly one booster. Three open slots, one real answer —
    // the planner must not invent two more it cannot power.
    const { picks } = planFills(DEFENSE, 3, { cpu: 2, power: 4 }, 'ore', 4)
    expect(picks.map(p => p.id)).toEqual(['shield_booster_i'])
  })

  test('no open slots means no recommendations', () => {
    expect(planFills(DEFENSE, 0, { cpu: 20, power: 50 }, 'ore', 4).picks).toHaveLength(0)
  })

  test('a speed-1 hull with only plates available gets nothing, not a stopped ship', () => {
    const { picks } = planFills([ARMOR_PLATE_I, ARMOR_PLATE_II], 2, { cpu: 20, power: 50 }, 'ore', 1)
    expect(picks).toHaveLength(0)
  })
})
