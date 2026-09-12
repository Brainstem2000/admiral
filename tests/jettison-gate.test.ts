import { describe, expect, test } from 'bun:test'
import { jettisonItems, jettisonSiteFrom, jettisonVerdict } from '../src/server/lib/tools'

/**
 * Jettison was banned fleet-wide. Game patch 0.594.0 (2026-09-06) made ore dumped
 * at its own deposit settle back into it, and Brian lifted the ban for exactly that
 * case on 2026-09-11 ("lift the jettison ban for Ledger at the belt"). The rule is
 * now the game's rule, enforced before the command leaves the harness: in space,
 * at a POI, ore that POI's deposits contain — nothing else, nowhere else.
 */
const belt = { poiId: 'silicon_flats_subra', docked: false, inTransit: false, deposits: ['silicon_ore', 'iron_ore', 'copper_ore', 'neodymium_ore'] }
const iron = [{ item_id: 'iron_ore', quantity: 390 }]

describe('jettison verdict', () => {
  test('filler ore dumped at the belt that holds it is allowed', () => {
    expect(jettisonVerdict(iron, belt)).toBeNull()
    expect(jettisonVerdict([{ item_id: 'iron_ore', quantity: 390 }, { item_id: 'copper_ore', quantity: 117 }], belt)).toBeNull()
  })
  test('an ore this POI does not mine would be destroyed, so it is refused by name', () => {
    const v = jettisonVerdict([{ item_id: 'creature_carapace', quantity: 6 }], belt)
    expect(v).toContain('BLOCKED'); expect(v).toContain('does not mine creature_carapace'); expect(v).toContain('0.594.0')
  })
  test('docked, in flight, at a POI with no deposits, or with an unknown position: refused', () => {
    expect(jettisonVerdict(iron, { ...belt, docked: true })).toContain('deposit_items')
    expect(jettisonVerdict(iron, { ...belt, inTransit: true })).toContain('in flight')
    expect(jettisonVerdict(iron, { ...belt, deposits: [] })).toContain('no deposits')
    expect(jettisonVerdict(iron, { ...belt, poiId: null })).toContain('position is unknown')
    expect(jettisonVerdict(iron, null)).toContain('position is unknown')
  })
  test('both documented argument shapes are read', () => {
    expect(jettisonItems({ item_id: 'iron_ore', quantity: 3 })).toEqual([{ item_id: 'iron_ore', quantity: 3 }])
    expect(jettisonItems({ items: [{ item_id: 'iron_ore', quantity: 3 }, { id: 'copper_ore' }] })).toEqual([{ item_id: 'iron_ore', quantity: 3 }, { item_id: 'copper_ore', quantity: null }])
    expect(jettisonItems(undefined)).toEqual([])
  })
  test('the site is read from a get_status-shaped state', () => {
    const site = jettisonSiteFrom({ location: { poi_id: 'x_belt', docked_at: null, in_transit: false, resources: [{ item_id: 'silicon_ore', remaining: 5 }] } })
    expect(site).toEqual({ poiId: 'x_belt', docked: false, inTransit: false, deposits: ['silicon_ore'] })
    expect(jettisonSiteFrom(null).poiId).toBeNull()
  })
})
