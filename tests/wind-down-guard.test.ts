/**
 * Wind-down: finish what you accepted, take on nothing new.
 *
 * The operator asked for agents to be QUIESCED — let in-flight missions play
 * out, turn them in, then dock — and the first attempt simply safe-docked
 * them, which stopped them mid-mission and left 263,419cr of accepted work
 * unclaimed. Safe-dock stops an agent where it stands; wind-down is the step
 * before it.
 *
 * The refusal lives in `checkDoctrineGuards` rather than in prompt wording
 * because this codebase has already measured that asking the model is not
 * enough (see WRAPUP_RESERVE_ROUNDS in CLAUDE.md, where a request to persist
 * state "was measurably ignored" until the toolset itself was restricted).
 *
 * The load-bearing distinction is acquisition vs completion: block the first,
 * never the second, or wind-down cannot do the one job it exists for.
 */
import { test, expect, describe, afterEach } from 'bun:test'
import { checkDoctrineGuards, setWindDown, isWindingDown } from '../src/server/lib/tools'

const P = 'wind-down-test-profile'
afterEach(() => setWindDown(P, false))

describe('wind-down flag', () => {
  test('is off by default and toggles', () => {
    expect(isWindingDown(P)).toBe(false)
    setWindDown(P, true)
    expect(isWindingDown(P)).toBe(true)
    setWindDown(P, false)
    expect(isWindingDown(P)).toBe(false)
  })

  test('guards nothing while it is off', () => {
    expect(checkDoctrineGuards('accept_mission', { template_id: 'x' }, P)).toBeNull()
  })
})

describe('acquisition is refused while winding down', () => {
  test('accept_mission is blocked', () => {
    setWindDown(P, true)
    const r = checkDoctrineGuards('accept_mission', { template_id: 'emergency_rations' }, P)
    expect(r).toContain('REFUSED')
    expect(r).toContain('winding down')
  })

  test('the spacemolt_ prefix does not smuggle it past', () => {
    setWindDown(P, true)
    expect(checkDoctrineGuards('spacemolt_accept_mission', {}, P)).toContain('REFUSED')
  })

  test('shipping accept is blocked in BOTH call shapes', () => {
    setWindDown(P, true)
    // group form and flat form both reach the server; guarding one is guarding none.
    expect(checkDoctrineGuards('shipping', { action: 'accept', shipment_id: 'a' }, P)).toContain('REFUSED')
    expect(checkDoctrineGuards('shipping_accept', { shipment_id: 'a' }, P)).toContain('REFUSED')
  })

  test('buying a ship or commissioning one is blocked', () => {
    setWindDown(P, true)
    expect(checkDoctrineGuards('commission_ship', {}, P)).toContain('REFUSED')
    expect(checkDoctrineGuards('buy_ship', {}, P)).toContain('REFUSED')
  })

  test('the refusal tells the agent it is not a bug', () => {
    // Cass read an earlier guard's refusal as "SHIPPING API BUG" and started
    // writing that into her memory. A false broken-API belief outlives the turn.
    setWindDown(P, true)
    expect(checkDoctrineGuards('accept_mission', {}, P)).toContain('not a bug')
  })
})

describe('completion is NEVER blocked — the point of winding down', () => {
  // NB: `sell` is deliberately absent — it has its own market-depth guard that
  // fires independently of wind-down, so including it would test that rule, not
  // this one.
  test('delivering and completing accepted work still passes', () => {
    setWindDown(P, true)
    for (const [cmd, args] of [
      ['complete_mission', { id: 'm1' }],
      ['shipping', { action: 'deliver', shipment_id: 's1' }],
      ['shipping_deliver', { shipment_id: 's1' }],
      ['travel', { id: 'poi' }],
      ['dock', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(checkDoctrineGuards(cmd, args, P)).toBeNull()
    }
  })

  test('one profile winding down does not gate another', () => {
    setWindDown(P, true)
    expect(checkDoctrineGuards('accept_mission', {}, 'some-other-profile')).toBeNull()
  })
})
