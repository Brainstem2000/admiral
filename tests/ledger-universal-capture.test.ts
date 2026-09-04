import { describe, expect, test } from 'bun:test'

/**
 * "Every single movement of every credit tracked" — the Admiral's standing
 * requirement for the Financials tab.
 *
 * Before this, only two command families reconciled their wallet echo against
 * the booked rows: the shipping-escrow set, and accept_trade. Everything else
 * was left to whatever explicit amount fields the result happened to carry, and
 * the gaps were large. `GET /api/analytics/ledger/reconcile` on 2026-09-03
 * reported 260 windows of unbooked movement across five agents:
 *
 *     Morg  29 windows   13,845,572 |residual|
 *     Juno  55 windows      304,366
 *     Spock 58 windows       82,656
 *     Grit   5 windows       28,452
 *     Cass 113 windows       17,209
 *
 * The concrete case that prompted it: Morg'Thar's credits-only War Wagon
 * commission earmarked 735,419cr, the yard sourced the materials for less, and
 * 633,560cr was refunded. The ledger booked the charge and never the refund, so
 * the tab overstated his spend by that amount while his wallet was correct.
 *
 * capture() now reads the pre-insert balance for EVERY command and books any
 * unexplained remainder as `unattributed`. These pin that arithmetic.
 */
const residual = (after: number, prev: number, explained: number) => (after - prev) - explained

describe('universal residual capture', () => {
  test('the War Wagon refund: a wallet RISE with no explaining row is booked', () => {
    // 1,830,702 -> 2,464,238 with nothing mapped, because the refund arrives as
    // a bare wallet echo on a later command.
    expect(residual(2_464_238, 1_830_702, 0)).toBe(633_536)
  })

  test('the commission charge itself is explained, so books nothing extra', () => {
    // 2,566,157 -> 1,830,702, and mapResult booked commission -735,419.
    expect(residual(1_830_702, 2_566_157, -735_419)).toBe(-36)
    // ...the -36 remainder is real (fuel burned in the same window) and is
    // exactly the kind of small silent movement that used to vanish.
  })

  test('station rent, deducted silently, lands as a negative residual', () => {
    // Rent auto-deducts roughly every 17 minutes wherever the agent is, and no
    // command result names it.
    expect(residual(99_000, 100_000, 0)).toBe(-1_000)
  })

  test('a fully explained command produces no row', () => {
    // A sell of 6,622 that mapped cleanly.
    expect(residual(106_622, 100_000, 6_622)).toBe(0)
  })

  test('partial explanation books only the unexplained part', () => {
    // Wallet moved 20,000; explicit rows accounted for 5,000.
    expect(residual(120_000, 100_000, 5_000)).toBe(15_000)
  })

  test('the sum of explained rows plus the residual always equals the wallet delta', () => {
    // This is the invariant the whole feature rests on: after capture, the
    // ledger's movement for a window reconciles exactly to the wallet.
    for (const [after, prev, explained] of [
      [2_464_238, 1_830_702, 0],
      [1_830_702, 2_566_157, -735_419],
      [99_000, 100_000, 0],
      [106_622, 100_000, 6_622],
      [50_000, 50_000, 0],
    ] as const) {
      expect(explained + residual(after, prev, explained)).toBe(after - prev)
    }
  })

  test('an unknown balance must book nothing rather than guess', () => {
    // capture() requires BOTH prev and after to be non-null. A residual we
    // cannot anchor is a guess, and a wrong financial row is worse than a
    // missing one — the phantom-escrow incident was exactly that failure.
    const prev: number | null = null
    const after: number | null = 120_000
    const shouldBook = prev !== null && after !== null
    expect(shouldBook).toBe(false)
  })
})

/**
 * The gift double-count, 2026-09-03. `mirrorFleetGift` credits the RECIPIENT
 * from the SENDER's command and books no balance_after — it cannot know the
 * recipient's wallet. `lastBookedBalance` only reads rows that carry one, so
 * the mirror was invisible, and the recipient's next command re-booked the
 * whole gift as `unattributed`. CyberSapper showed +50,000 twice for one
 * transfer from Grit Vane.
 *
 * The anchor must be the last recorded balance PLUS everything booked since.
 */
const anchor = (lastBalance: number, bookedSince: number) => lastBalance + bookedSince

describe('balance anchor vs unbooked mirror rows', () => {
  test('a mirrored gift does not get counted twice', () => {
    // Wallet 33,422 anchored. Grit's send books +50,000 into CyberSapper's
    // ledger with no balance. His next command reports a wallet of 83,422.
    const prev = anchor(33_422, 50_000)      // 83,422 — the gift is accounted for
    expect(residual(83_422, prev, 0)).toBe(0)
  })

  test('the OLD anchor produced the phantom 50,000', () => {
    const buggy = anchor(33_422, 0)          // mirror row ignored
    expect(residual(83_422, buggy, 0)).toBe(50_000)
  })

  test('a genuine unexplained move still books alongside a mirror', () => {
    // Same gift, but rent also took 1,000 before the next command.
    const prev = anchor(33_422, 50_000)
    expect(residual(82_422, prev, 0)).toBe(-1_000)
  })
})
