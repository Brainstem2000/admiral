import { describe, expect, test } from 'bun:test'
import { priceTrapVerdict } from '../src/server/lib/tools'

/**
 * The buy gate used to check price only for fuel cells. On 2026-09-11 CyberSpock paid
 * 2,632 each for 15 flex_polymer at Iron Reach (fleet asks 158-160, base value 27) and
 * Juno paid 18,063 each for six energy_crystal (fleet asks ~1,400). Both slipped past
 * the depth and repeat-purchase guards because neither looks at the price. The verdict
 * is pure: the fleet's cheapest recent ask is the yardstick, base value the fallback,
 * and a genuine market price (titanium_alloy at 25x base, everywhere) must pass.
 */
describe('buy price trap', () => {
  test('flex polymer at 17x the fleet ask is blocked', () => {
    expect(priceTrapVerdict('flex_polymer', 2632, 158, 27)).toContain('lowball trap')
  })
  test('energy crystal at 13x the fleet ask is blocked', () => {
    expect(priceTrapVerdict('energy_crystal', 18063, 1400, 350)).toContain('lowball trap')
  })
  test('titanium at the fleet-wide price passes even though it is 25x base value', () => {
    expect(priceTrapVerdict('titanium_alloy', 2500, 2500, 100)).toBeNull()
    expect(priceTrapVerdict('titanium_alloy', 2500, null, 100)).toBeNull()
  })
  test('a modest premium over the fleet ask passes', () => {
    expect(priceTrapVerdict('mining_laser_iii', 21422, 16828, 7900)).toBeNull()
  })
  test('with no fleet reference, 111x base value is blocked and the message says so', () => {
    const v = priceTrapVerdict('steel_plate', 2000, null, 18)
    expect(v).toContain('111x'); expect(v).toContain('no recent ask')
  })
  test('unknown base and unknown fleet ask cannot judge, so it passes', () => {
    expect(priceTrapVerdict('mystery_item', 99999, null, null)).toBeNull()
  })
})
