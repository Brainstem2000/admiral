/**
 * A re-asked fleet order must refresh the standing request, not mint another row.
 *
 * On 2026-09-03 CyberSpock asked seven agents to transfer iron_ore to Crimson War
 * Citadel. Nobody replied, so he re-sent — and every re-send created a NEW order.
 * The result was 33 open orders in 74 minutes for one request, still sitting there
 * two days later. Four were addressed to Ledger Voss, who held zero iron_ore at any
 * station, so they were unfulfillable the moment they were written; meanwhile the
 * requester already had 475 iron_ore at the destination, with 1,940 more held by two
 * other agents at that same station.
 *
 * Two costs: each duplicate nudged and interrupted a running agent, and each one
 * showed on its recipient's row as outstanding work — which is how a fabricated
 * escrow claim and a pile of dead letters read to the Admiral as "an agent is
 * blocked waiting on me".
 */
import { test, expect, describe } from 'bun:test'
import { fleetOrderFingerprint } from '../src/server/lib/db'

describe('fleet order intent fingerprint', () => {
  test('the real 2026-09-03 re-asks collapse to one intent', () => {
    // Verbatim descriptions from the incident.
    const reasks = [
      'Transfer iron_ore 500 to Crimson War Citadel for Workshop Toolkit',
      'Transfer iron_ore to Crimson War Citadel storage',
      'Transfer iron_ore to my storage at Crimson War Citadel',
      'Transfer iron_ore 997 to my station storage',
    ]
    const prints = new Set(reasks.map(d => fleetOrderFingerprint('custom', d)))
    expect(prints.size).toBe(1)
  })

  test('a different item is a different request', () => {
    expect(fleetOrderFingerprint('custom', 'Transfer iron_ore 500 to the citadel'))
      .not.toBe(fleetOrderFingerprint('custom', 'Transfer titanium_ore 500 to the citadel'))
  })

  test('a different verb is a different request', () => {
    // "Gift iron_ore to X" and "Transfer iron_ore to X" are not the same ask.
    expect(fleetOrderFingerprint('custom', 'Gift iron_ore x500 to Juno'))
      .not.toBe(fleetOrderFingerprint('custom', 'Transfer iron_ore 500 to Juno'))
  })

  test('a different order type is a different request', () => {
    expect(fleetOrderFingerprint('haul', 'Move iron_ore to base'))
      .not.toBe(fleetOrderFingerprint('mine', 'Move iron_ore to base'))
  })

  test('free-text orders with no identifiers still collapse when re-sent verbatim', () => {
    const d = 'Provide your storage breakdown at the citadel'
    expect(fleetOrderFingerprint('custom', d)).toBe(fleetOrderFingerprint('custom', d))
  })

  test('free-text orders that differ do not collapse', () => {
    expect(fleetOrderFingerprint('custom', 'Provide your storage breakdown'))
      .not.toBe(fleetOrderFingerprint('custom', 'Report your combat readiness'))
  })

  test('identifier order and letter case do not matter', () => {
    expect(fleetOrderFingerprint('custom', 'Transfer iron_ore and copper_ore to war_citadel'))
      .toBe(fleetOrderFingerprint('CUSTOM', 'transfer copper_ore and iron_ore to war_citadel'))
  })
})
