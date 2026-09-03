import { describe, expect, test } from 'bun:test'
import { renderFreight } from '../src/server/lib/briefing'

/**
 * Cass Margin, 2026-09-02: idle a whole session at Gold Run broadcasting "no
 * viable independent income" while a freight contract she had already accepted
 * counted down to a 500cr penalty — the package sitting in her own storage
 * three systems away. Her prompt never mentioned the contract existed.
 *
 * Freight is an obligation with its own clock that BILLS the agent for
 * inaction, so it belongs in the injected briefing next to missions.
 */

// Trimmed from the real `shipping(action="active")` payload.
const LIVE = [{
  contract: {
    id: '0c73afd9ffdea0da9931faee176cf9c7',
    package_id: '62e180b6a24e74c396d3318f41111de8',
    origin_base_id: 'market_prime_exchange',
    destination_base_id: 'the_levy_customs_station',
    route_hops: 3,
    base_reward: 1,
    failure_debt: 500,
    reserved_exposure: 4500,
    status: 'in_transit',
  },
  role: 'carrier',
  origin_name: 'Market Prime Exchange',
  destination_name: 'The Levy Customs Station',
  ticks_to_target: -94,
  ticks_to_deadline: 416,
  ticks_to_recovery_deadline: 3296,
  late: false,
  payout_if_delivered_now: 1,
  failure_debt: 500,
  package_in_your_cargo: false,
  last_known_location: 'player_storage at Market Prime Exchange',
  next_step: 'Withdraw package 62e180b6a24e74c396d3318f41111de8 from storage',
}]

describe('renderFreight', () => {
  test('says nothing when there is no freight', () => {
    expect(renderFreight(null)).toEqual([])
    expect(renderFreight([])).toEqual([])
  })

  test('surfaces the money at risk, not just the contract', () => {
    const out = renderFreight(LIVE).join('\n')
    expect(out).toContain('FAILURE DEBT 500cr')      // the actual exposure
    expect(out).toContain('4.5Kcr of your liability cap')
    expect(out).toContain('Market Prime Exchange → The Levy Customs Station')
  })

  test('relays the game\'s own next_step rather than re-deriving a plan', () => {
    const out = renderFreight(LIVE).join('\n')
    expect(out).toContain("NEXT STEP (the game's own)")
    expect(out).toContain('Withdraw package 62e180b6a24e74c396d3318f41111de8')
  })

  test('says where the package actually is when it is not aboard', () => {
    const out = renderFreight(LIVE).join('\n')
    expect(out).toContain('NOT in your hold')
    expect(out).toContain('player_storage at Market Prime Exchange')
    const aboard = renderFreight([{ ...LIVE[0], package_in_your_cargo: true }]).join('\n')
    expect(aboard).toContain('IS in your hold')
  })

  test('converts tick countdowns to wall-clock so a deadline reads as urgent', () => {
    const out = renderFreight(LIVE).join('\n')
    expect(out).toContain('416 ticks')
    expect(out).toContain('1.2h')        // 416 ticks x 10s
    expect(out).toContain('9.2h')        // recovery window
  })

  test('flags a lapsed deadline even when the payload does not set `late`', () => {
    const out = renderFreight([{ ...LIVE[0], ticks_to_deadline: -20, late: false }]).join('\n')
    expect(out).toContain('⚠ LATE')
    expect(out).toContain('AGO')
  })

  test('teaches the one-command syntax, and that not_docked means wrong station', () => {
    const out = renderFreight(LIVE).join('\n')
    expect(out).toContain('shipping(action=')
    expect(out).toContain('contract_id="0c73afd9ffdea0da9931faee176cf9c7"')
    expect(out).toContain('WRONG STATION')
  })

  test('skips malformed rows instead of throwing mid-briefing', () => {
    const out = renderFreight([null, 'nonsense', {}, { contract: {} }, LIVE[0]])
    expect(out.join('\n')).toContain('ACTIVE FREIGHT (1)')
  })
})
