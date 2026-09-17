import { describe, expect, test } from 'bun:test'
import { computeShipBuild, parseCargoItems } from '../src/server/lib/ship-build'

/**
 * A ship commission and a facility build read OPPOSITE places, and conflating
 * them is the most expensive storage error this project makes (plan §30):
 *
 *   facility_build     -> packages, FACTION STORAGE at the station, then cargo.
 *   supply_commission  -> the pilot's CARGO, then the pilot's PERSONAL locker.
 *                         Faction storage is NOT read — that applies only at a
 *                         station the faction owns, and we own none.
 *
 * So a part in the vault is invisible to the yard even though it sits in the same
 * station. On 2026-09-17 seven of the Devastator's seventeen lines were fully
 * covered and every one of them was vaulted: a page that summed the vault into
 * "have" would have reported the ship ready to order while the yard saw nothing.
 */

const m = (o: Record<string, number>) => new Map(Object.entries(o))
const none = () => 0

describe('the ship bill counts only what the commission can reach', () => {
  test('vault stock is never commission_ready — it reports as a withdrawal', () => {
    const r = computeShipBuild({
      bill: [{ item_id: 'durasteel_plate', quantity: 80 }],
      cargo: m({}), locker: m({}), vault: m({ durasteel_plate: 500 }), elsewhereFor: none,
    })
    const line = r.lines[0]
    expect(line.vault).toBe(500)
    expect(line.commission_ready).toBe(0)      // the yard cannot see a single one
    expect(line.short).toBe(80)
    expect(line.status).toBe('withdraw')       // actionable, not "ready"
    expect(r.ready_count).toBe(0)
    expect(r.withdraw_count).toBe(1)
  })

  test('cargo and the pilot locker both count, cargo first', () => {
    const r = computeShipBuild({
      bill: [{ item_id: 'capital_ship_frame', quantity: 12 }],
      cargo: m({ capital_ship_frame: 5 }), locker: m({ capital_ship_frame: 7 }),
      vault: m({}), elsewhereFor: none,
    })
    const line = r.lines[0]
    expect(line.cargo).toBe(5)
    expect(line.locker).toBe(7)
    expect(line.commission_ready).toBe(12)
    expect(line.short).toBe(0)
    expect(line.status).toBe('ready')
  })

  test('a vault holding PART of a line still says withdraw, never merely "fetch"', () => {
    // 116 of 120 fury_alloy vaulted, and stock exists elsewhere too. The advice
    // must surface the 116 we are standing on rather than dispatch a hauler for
    // the whole line.
    const r = computeShipBuild({
      bill: [{ item_id: 'fury_alloy', quantity: 120 }],
      cargo: m({}), locker: m({}), vault: m({ fury_alloy: 116 }), elsewhereFor: () => 400,
    })
    expect(r.lines[0].status).toBe('withdraw_partial')
    expect(r.withdraw_count).toBe(1)
  })

  test('only a line with nothing local and nothing vaulted is a fetch', () => {
    const r = computeShipBuild({
      bill: [{ item_id: 'weapon_core', quantity: 220 }],
      cargo: m({}), locker: m({}), vault: m({}), elsewhereFor: () => 89,
    })
    expect(r.lines[0].status).toBe('fetch')
  })

  test('nothing anywhere is short — buy, craft or mine', () => {
    const r = computeShipBuild({
      bill: [{ item_id: 'neutronium_ingot', quantity: 18 }],
      cargo: m({}), locker: m({}), vault: m({}), elsewhereFor: none,
    })
    expect(r.lines[0].status).toBe('short')
    expect(r.binding).toBe('neutronium_ingot')
  })

  test('elsewhere is consulted ONLY when the local picture cannot cover the line', () => {
    // A fleet-wide sum is the trap; a covered line must not go looking abroad.
    let consulted = 0
    computeShipBuild({
      bill: [{ item_id: 'armor_plate', quantity: 60 }],
      cargo: m({}), locker: m({ armor_plate: 81 }), vault: m({}),
      elsewhereFor: () => { consulted++; return 999 },
    })
    expect(consulted).toBe(0)
  })

  test('percent is the BINDING ratio, not the average', () => {
    const r = computeShipBuild({
      bill: [
        { item_id: 'hull_plating', quantity: 100 },      // fully covered
        { item_id: 'neutronium_ingot', quantity: 18 },   // nothing at all
      ],
      cargo: m({}), locker: m({ hull_plating: 100 }), vault: m({}), elsewhereFor: none,
    })
    // Averaging would call this ship 50% done. It cannot be commissioned at all.
    expect(r.pct).toBe(0)
    expect(r.binding).toBe('neutronium_ingot')
    expect(r.ready_count).toBe(1)
    expect(r.total).toBe(2)
  })
})

describe('cargo strings from the live agent state', () => {
  test('parses "item_id xN" and sums duplicates', () => {
    const c = parseCargoItems(['tungsten_ore x21', 'carbon_ore x42', 'tungsten_ore x9'])
    expect(c.get('tungsten_ore')).toBe(30)
    expect(c.get('carbon_ore')).toBe(42)
  })

  test('ignores malformed entries rather than counting them as one', () => {
    const c = parseCargoItems(['', 'junk', 'copper_ore x8', null, undefined])
    expect(c.size).toBe(1)
    expect(c.get('copper_ore')).toBe(8)
  })
})
