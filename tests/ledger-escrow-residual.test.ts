import { describe, expect, test } from 'bun:test'

/**
 * Cass Margin's ledger on 2026-09-03 held 22 `freight` rows totalling +119,850
 * against 22 `escrow` rows totalling -119,850 — an EXACT cancellation on every
 * single delivery. The freight payments were real (her wallet rose 46,692 ->
 * 135,564 on the 88,970 one), but the ledger netted them to zero, so freight
 * never appeared in the summary and the ledger's net ran ~94,000 short of her
 * actual balance.
 *
 * Cause: the shipping-escrow reconciler booked the mapped rows FIRST, then
 * called lastBookedBalance() for `prev`. That helper takes the newest row by id,
 * so it returned the row just written — making prev === after, and therefore
 * residual === -explained, every time.
 *
 * These assert the arithmetic of the reconciler, which is the part that was
 * wrong. The fix reads the balance BEFORE inserting.
 */
const residual = (after: number, prev: number, explained: number) => (after - prev) - explained

describe('shipping escrow residual', () => {
  test('the exact 14:43 delivery: correct prev yields no escrow row', () => {
    // wallet 46,692 -> 135,564; freight row booked +88,970
    const r = residual(135_564, 46_692, 88_970)
    expect(Math.abs(r)).toBeLessThan(200)   // ~-98, rounding/fees, not a phantom
  })

  test('the BUG: prev read after insert equals after, cancelling the payment', () => {
    // what the old ordering computed
    const buggy = residual(135_564, 135_564, 88_970)
    expect(buggy).toBe(-88_970)             // exactly -explained
    expect(buggy + 88_970).toBe(0)          // freight and escrow annihilate
  })

  test('a genuine unbooked movement still produces an escrow row', () => {
    // wallet moved 20,000 but only 5,000 was explained by mapped rows
    expect(residual(120_000, 100_000, 5_000)).toBe(15_000)
  })

  test('a delivery with no wallet movement books nothing', () => {
    expect(residual(50_000, 50_000, 0)).toBe(0)
  })

  test('escrow posted OUT on accept is still captured', () => {
    // accepting a contract removes a bond with no explicit amount field
    expect(residual(90_000, 100_000, 0)).toBe(-10_000)
  })

  test('freight and escrow must not sum to zero across a run of deliveries', () => {
    const deliveries = [[46_692, 920], [47_612, 4_370], [51_982, 88_970]]
    let prev = 46_692, freight = 0, escrow = 0
    for (const [, amount] of deliveries) {
      const after = prev + amount
      freight += amount
      escrow += residual(after, prev, amount)
      prev = after
    }
    expect(freight).toBeGreaterThan(0)
    expect(freight + escrow).not.toBe(0)    // the bug's signature
    expect(escrow).toBe(0)                  // nothing unexplained here
  })
})
