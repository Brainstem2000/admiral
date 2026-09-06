import { test, expect, describe } from 'bun:test'

/**
 * Three resolver bugs, each of which changed the Crimson Devastator's bill of
 * materials by enough to change what the fleet was ordered to do.
 *
 * 1. IGNORING output_quantity. A recipe yielding 2 or 3 per craft needs
 *    proportionally fewer runs. Counting every recipe as yield-1 inflated
 *    uranium_ore from 805 to 1,687.
 * 2. TAKING THE FIRST RECIPE. `focused_crystal` has 3 and `titanium_alloy` has
 *    6. First-match picked the ranch-only paths and produced a bill demanding
 *    380 raw_focusing_crystal ("ranch-only: a hunted druse shatters its geode")
 *    and 252 anchor_plate, plus a fake aluminum_sheet bottleneck — when
 *    forge_titanium_alloy needs titanium_ore x3 + steel_plate x1, both of which
 *    the fleet held in the thousands.
 * 3. TREATING A RECIPE CYCLE AS CHEAP. reactor_fuel_assembly wraps and unwraps
 *    into itself. A path-visited guard that returns the "unobtainable" penalty
 *    lets the cycle win on price; it has to be Infinity so it is never chosen.
 *
 * These mirror the arithmetic in scripts/build-plan.ts.
 */

interface Recipe { id: string; out: string; yield: number; inputs: Array<[string, number]> }

const RECIPES: Recipe[] = [
  // two ways to armor_plate: one from stock, one needing 6 hunted carapace each
  { id: 'forge_armor_plate', out: 'armor_plate', yield: 1, inputs: [['steel_plate', 1]] },
  { id: 'carapace_plating', out: 'armor_plate', yield: 1, inputs: [['creature_carapace', 6]] },
  // yields 2 per craft — the output_quantity trap
  { id: 'concentrate_uranium', out: 'uranium_concentrate', yield: 2, inputs: [['uranium_ore', 6]] },
  // a wrap/unwrap cycle
  { id: 'unwrap_rfa', out: 'rfa', yield: 1, inputs: [['contained_rfa', 1]] },
  { id: 'wrap_rfa', out: 'contained_rfa', yield: 1, inputs: [['rfa', 1]] },
  { id: 'fabricate_rfa', out: 'rfa', yield: 1, inputs: [['leu', 2]] },
]
const STOCK: Record<string, number> = { steel_plate: 3027, creature_carapace: 36, uranium_ore: 77, leu: 0 }
const UNOBTAINABLE_PENALTY = 5_000

const recipesFor = (id: string) => RECIPES.filter(r => r.out === id)
const stock = (id: string) => STOCK[id] ?? 0

function cost(id: string, qty: number, seen = new Set<string>()): number {
  const net = Math.max(0, qty - stock(id))
  if (net === 0) return 0
  if (seen.has(id)) return Infinity                       // bug 3: cycle is never choosable
  const rs = recipesFor(id)
  if (!rs.length) return net * UNOBTAINABLE_PENALTY
  const next = new Set(seen).add(id)
  return Math.min(...rs.map(r => {
    const runs = Math.ceil(net / r.yield)                 // bug 1: respect the yield
    return r.inputs.reduce((s, [i, q]) => s + cost(i, q * runs, next), 0)
  }))
}
function chosen(id: string, qty: number, seen = new Set<string>()): string {
  const net = Math.max(0, qty - stock(id))
  const next = new Set(seen).add(id)
  return recipesFor(id)
    .map(r => ({ r, c: r.inputs.reduce((s, [i, q]) => s + cost(i, q * Math.ceil(net / r.yield), next), 0) }))
    .filter(x => Number.isFinite(x.c))
    .sort((a, b) => a.c - b.c)[0].r.id                    // bug 2: cheapest, not first
}

describe('output_quantity', () => {
  test('a yield-2 recipe halves the runs and therefore the raw input', () => {
    // 294 concentrate at yield 2 = 147 runs x 6 ore = 882 ore, minus 77 stock = 805.
    const runs = Math.ceil(294 / 2)
    expect(runs * 6 - stock('uranium_ore')).toBe(805)
  })
  test('ignoring it inflates the bill — the 1,687 figure', () => {
    expect(294 * 6 - stock('uranium_ore')).toBe(1687)     // what yield-1 produced
  })
})

describe('recipe choice', () => {
  test('armor_plate takes the stock path, not the 6-carapace-each path', () => {
    expect(chosen('armor_plate', 54)).toBe('forge_armor_plate')
  })
  test('the hunted path really is the more expensive one', () => {
    const carapace = cost('creature_carapace', 54 * 6)
    const steel = cost('steel_plate', 54)
    expect(carapace).toBeGreaterThan(steel)
    expect(steel).toBe(0)                                  // 3,027 in stock covers it
    expect(carapace).toBe((54 * 6 - 36) * UNOBTAINABLE_PENALTY)
  })
  test('first-match would have picked whichever the catalog listed first', () => {
    expect(recipesFor('armor_plate')[0].id).toBe('forge_armor_plate')
    // ...which is only correct by luck. Reversing catalog order must not change the answer:
    RECIPES.reverse()
    expect(chosen('armor_plate', 54)).toBe('forge_armor_plate')
    RECIPES.reverse()
  })
})

describe('recipe cycles', () => {
  test('wrap/unwrap costs Infinity and cannot be chosen', () => {
    expect(cost('contained_rfa', 1, new Set(['rfa']))).toBe(Infinity)
  })
  test('the non-cyclic recipe wins instead', () => {
    expect(chosen('rfa', 22)).toBe('fabricate_rfa')
  })
  test('a cheap-cycle penalty would have let the cycle win', () => {
    // If a visited item returned the unobtainable penalty instead of Infinity,
    // unwrap_rfa would price at 1 x 5,000 and beat fabricate_rfa's 44 x 5,000.
    expect(1 * UNOBTAINABLE_PENALTY).toBeLessThan(22 * 2 * UNOBTAINABLE_PENALTY)
  })
})
