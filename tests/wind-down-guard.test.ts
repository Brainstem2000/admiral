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
    // The REAL purchase command. The first version of this guard named
    // `buy_ship`, which is not a game command at all (lib spec v0.547.0 exposes
    // ship.buy_listed_ship), so that entry could never fire — a guard against a
    // command nobody can call is not a guard.
    expect(checkDoctrineGuards('buy_listed_ship', { listing_id: 'x' }, P)).toContain('REFUSED')
    expect(checkDoctrineGuards('place_ship_buy_order', {}, P)).toContain('REFUSED')
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

/**
 * Wind-down must FAIL CLOSED on an unreadable mission count.
 *
 * The first shipped version returned 0 from `payableMissionsRemaining()` on a
 * failed read and treated that as "nothing left to do". Armed on Cass Margin
 * at 19:13:29, the first check ran while her connection was still coming up,
 * read nothing, and docked her immediately — before the 2,500cr delivery she
 * had been woken to make. She completed it only because the reconnect landed
 * after the disconnect.
 *
 * `null` (unknown) must never be treated as `0` (done). The turn budget is the
 * backstop for a genuinely stuck agent; a transport hiccup is not that.
 */
describe('payable-mission counting fails closed', () => {
  // Mirrors the parser in Agent.payableMissionsRemaining.
  function countPayable(text: string | null): number | null {
    if (text == null) return null
    if (!text.trim()) return null
    return text.split('--- ').slice(1)
      .filter(b => /Rewards:\s*[\d,]+\s*cr/i.test(b)).length
  }

  test('an unreadable or empty response is unknown, not zero', () => {
    expect(countPayable(null)).toBeNull()
    expect(countPayable('')).toBeNull()
    expect(countPayable('   ')).toBeNull()
  })

  test('a real roster with no paying missions counts zero', () => {
    const text = 'Active missions (1/5):\n--- Distress: Wexler Q75-M5 [abc] (distress_response, difficulty 5) ---\n'
      + 'Objectives:\n  - Investigate: 0/1\nRewards: +25 piloting XP\nExpires in: 47 ticks\n'
    expect(countPayable(text)).toBe(0)
  })

  test('credit rewards hold the wind-down open; XP-only ones do not', () => {
    const text = 'Active missions (2/5):\n'
      + '--- Emergency Rations [a1] (delivery, difficulty 2) ---\nRewards: 2,500cr, +35 trading XP\n'
      + '--- Distress: Wexler [b2] (distress_response, difficulty 5) ---\nRewards: +25 piloting XP\n'
    expect(countPayable(text)).toBe(1)
  })

  test('only a real zero ends the wind-down', () => {
    // The exact confusion that docked Cass early.
    const unknown = countPayable(null)
    const done = countPayable('Active missions (0/5):\n')
    expect(unknown === 0).toBe(false)
    expect(done).toBe(0)
  })
})
