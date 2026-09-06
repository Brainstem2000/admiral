import { describe, expect, test } from 'bun:test'
import { checkDoctrineGuards } from '../src/server/lib/tools'
import { resetAbandons } from '../src/server/lib/mission-guard'

/**
 * A guard that THROWS is worse than no guard at all.
 *
 * On 2026-09-05 the Wexler-rescue and abandon-churn guards were added to
 * `checkDoctrineGuards` copying an idiom (`ctx.profileId`, `ctx.log(...)`)
 * from the tool-execution path, where `ctx` exists. `checkDoctrineGuards`
 * takes a bare `profileId` and has no `ctx`. The duplicate-commission guard
 * carried the same mistake. `refuseAbandon(ctx.profileId)` is evaluated
 * UNCONDITIONALLY on every abandon_mission, so from that commit onward every
 * abandon crashed the turn with a ReferenceError — five in ten minutes on
 * Morg'Thar, each one losing the whole turn's work. `tsc` reported it as five
 * TS2304s that were filtered out of every typecheck all day as "pre-existing
 * Bun noise".
 *
 * So: drive EVERY command family the guard branches on and assert it returns
 * rather than throws. This is deliberately not a behaviour test — the
 * behaviour of each gate is pinned by its own file. It exists so that a
 * reference error in any branch fails here instead of in production.
 */

const P = 'smoke-profile'

/** Every command the guard dispatches on, plus the v2-prefixed spellings. */
const GUARDED: Array<[string, Record<string, unknown> | undefined]> = [
  ['dock', { station_id: 'crimson_war_citadel' }],
  ['ship_dock', { station_id: 'crimson_war_citadel' }],
  ['spacemolt_dock', { station_id: 'crimson_war_citadel' }],
  ['commission_ship', { ship_class: 'crimson_devastator' }],
  ['spacemolt_ship_commission_ship', { ship_class: 'crimson_devastator' }],
  ['accept_mission', { mission_id: 'm1' }],
  ['spacemolt_mission_accept_mission', { mission_id: 'm1' }],
  ['abandon_mission', { mission_id: 'm1' }],
  ['spacemolt_mission_abandon_mission', { mission_id: 'm1' }],
  ['jettison', { item_id: 'iron_ore', quantity: 3 }],
  ['spacemolt_ship_jettison', { item_id: 'iron_ore', quantity: 3 }],
  ['sell', { item_id: 'iron_ore', quantity: 3 }],
  ['create_sell_order', { item_id: 'iron_ore', quantity: 3, price: 10 }],
  ['shipping', { action: 'accept', shipment_id: 's1' }],
  ['shipping_accept', { shipment_id: 's1' }],
  ['buy_listed_ship', { listing_id: 'x' }],
  ['place_ship_buy_order', {}],
  // Unguarded commands share the entry point and must survive it too.
  ['get_status', undefined],
  ['view_market', {}],
  ['get_missions', undefined],
]

describe('checkDoctrineGuards never throws', () => {
  for (const [command, args] of GUARDED) {
    test(`${command} returns a string or null`, () => {
      resetAbandons(P)
      let out: string | null | undefined
      expect(() => { out = checkDoctrineGuards(command, args, P) }).not.toThrow()
      expect(out === null || typeof out === 'string').toBe(true)
    })
  }

  test('survives with no args and no system id', () => {
    for (const [command] of GUARDED) {
      resetAbandons(P)
      expect(() => checkDoctrineGuards(command, undefined, P)).not.toThrow()
    }
  })

  test('survives a known system id on the reputation branch', () => {
    expect(() => checkDoctrineGuards('dock', { station_id: 's' }, P, 'krynn')).not.toThrow()
    expect(() => checkDoctrineGuards('dock', { station_id: 's' }, P, null)).not.toThrow()
  })

  test('repeated abandons reach the churn refusal instead of crashing', () => {
    resetAbandons(P)
    const seen: Array<string | null> = []
    for (let i = 0; i < 6; i++) seen.push(checkDoctrineGuards('abandon_mission', { mission_id: `m${i}` }, P))
    // The first few pass; once the window fills, the guard refuses. Either way
    // every call returned — nothing here may throw.
    expect(seen.every(v => v === null || typeof v === 'string')).toBe(true)
    expect(seen.some(v => typeof v === 'string')).toBe(true)
    resetAbandons(P)
  })
})
