import { describe, expect, test } from 'bun:test'
import { jettisonItems, jettisonSiteFrom, jettisonVerdict } from '../src/server/lib/tools'

/**
 * THE POLICY CHANGED ON 2026-09-17. Brian: "Cyberspock should not be allowed to Jettison anything.
 * No one should. Everything gets stored."
 *
 * History, because the shape of the failure matters. Jettison was banned fleet-wide, then patch
 * 0.594.0 made ore dumped at its own deposit settle back into it, and Brian lifted the ban for
 * exactly that case on 2026-09-11. This file used to assert that permissive rule, and the guard
 * enforced it correctly all day on 2026-09-17 — refusing Grit while docked, Juno while docked, and
 * Rook for an ore the POI did not mine.
 *
 * Then it ALLOWED CyberSpock to dump 53 fury_crystal at Iron Reach Mineral Fields, which does mine
 * fury_crystal. Technically lossless: the ore settled back into the rock. But he had just spent the
 * turns mining it, fury_crystal is the best-paying cargo in the game (320 into a 10,849-deep wall),
 * and he kept carbon_ore at a bid of 2 in its place. A rule that is correct about the game and
 * still lets an agent throw away the cargo it was sent to fetch is the wrong rule.
 *
 * So there is no per-site judgement any more. The command is refused everywhere, and the refusal
 * tells the agent where the cargo actually goes. `mine_until_full(keep=…)` keeps its own dump cycle
 * — see the carve-out in tools.ts — because that returns filler to the deposit that produced it in
 * order to make room for the ore that pays, which is how valuable cargo ends up STORED.
 */
const belt = { poiId: 'silicon_flats_subra', docked: false, inTransit: false, deposits: ['silicon_ore', 'iron_ore', 'copper_ore', 'neodymium_ore'] }
const iron = [{ item_id: 'iron_ore', quantity: 390 }]

describe('jettison is refused everywhere, without exception', () => {
  test('the case that used to be ALLOWED — filler at the belt that holds it — is now refused', () => {
    const v = jettisonVerdict(iron, belt)
    expect(v).not.toBeNull()
    expect(v).toContain('BLOCKED')
    expect(v).toContain('Everything gets stored')
  })

  test('the exact CyberSpock case: the best-paying ore, at a POI that mines it', () => {
    const field = { poiId: 'iron_reach_mineral_fields', docked: false, inTransit: false, deposits: ['fury_crystal', 'tungsten_ore', 'carbon_ore'] }
    expect(jettisonVerdict([{ item_id: 'fury_crystal', quantity: 53 }], field)).toContain('BLOCKED')
  })

  test('docked, in flight, no deposits, unknown position — all still refused', () => {
    for (const site of [{ ...belt, docked: true }, { ...belt, inTransit: true }, { ...belt, deposits: [] }, { ...belt, poiId: null }, null]) {
      expect(jettisonVerdict(iron, site)).toContain('BLOCKED')
    }
  })

  test('the refusal names the alternatives rather than just saying no', () => {
    const v = jettisonVerdict(iron, belt)!
    expect(v).toContain('deposit_items')            // dock and store
    expect(v).toContain('faction')                  // or vault it
    expect(v).toContain('mine_until_full')          // the right tool for a full hold
    // And it must not send anyone to sell on an empire average — that error cost three seams today.
    expect(v).toContain('view_market')
  })

  test('the position context still colours the message where it helps', () => {
    expect(jettisonVerdict(iron, { ...belt, docked: true })).toContain('docked')
    expect(jettisonVerdict(iron, { ...belt, inTransit: true })).toContain('in flight')
  })

  test('both documented argument shapes are still read', () => {
    expect(jettisonItems({ item_id: 'iron_ore', quantity: 3 })).toEqual([{ item_id: 'iron_ore', quantity: 3 }])
    expect(jettisonItems({ items: [{ item_id: 'iron_ore', quantity: 3 }, { id: 'copper_ore' }] })).toEqual([{ item_id: 'iron_ore', quantity: 3 }, { item_id: 'copper_ore', quantity: null }])
    expect(jettisonItems(undefined)).toEqual([])
  })

  test('the site is still read from a get_status-shaped state', () => {
    const site = jettisonSiteFrom({ location: { poi_id: 'x_belt', docked_at: null, in_transit: false, resources: [{ item_id: 'silicon_ore', remaining: 5 }] } })
    expect(site).toEqual({ poiId: 'x_belt', docked: false, inTransit: false, deposits: ['silicon_ore'] })
    expect(jettisonSiteFrom(null).poiId).toBeNull()
  })
})
