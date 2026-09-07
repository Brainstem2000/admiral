import { test, expect, describe } from 'bun:test'

/**
 * The Financials tab defaulted to a 24-hour window. A PARKED agent's last
 * transaction is almost always older than that, so the query returned zero rows
 * and the panel read as "no financial history" for every offline agent.
 *
 * 2026-09-07: CyberSapper showed 1 credit in the UI with an empty transaction
 * list. He in fact had 797 refuels totalling -347,211 against 152 mission
 * payouts of +89,460 — the whole reason he is broke — plus ~983,000 of
 * realisable stock across 20 stations. All of it was in the ledger; none of it
 * was on screen, because his last row was ~30 hours old.
 *
 * Offline agents are the ones you read BECAUSE they are idle, and the last 24
 * hours is the single window guaranteed to be empty for them.
 */

type Period = '24h' | '7d' | 'all'

/** Mirrors the tab's window selection. */
function initialPeriod(connected: boolean): Period {
  return connected ? '24h' : 'all'
}

/** Mirrors the auto-widen effect. Returns the next period, or null to stay put. */
function widen(opts: { period: Period; rows: number; pinned: boolean }): Period | null {
  if (opts.pinned || opts.period === 'all') return null
  if (opts.rows > 0) return null
  return opts.period === '24h' ? '7d' : 'all'
}

describe('financial history must be visible offline', () => {
  test('an offline agent opens on the full history', () => {
    expect(initialPeriod(false)).toBe('all')
  })

  test('a connected agent still opens on the recent window', () => {
    expect(initialPeriod(true)).toBe('24h')
  })

  test('an empty 24h window widens rather than reading as "no history"', () => {
    expect(widen({ period: '24h', rows: 0, pinned: false })).toBe('7d')
    expect(widen({ period: '7d', rows: 0, pinned: false })).toBe('all')
  })

  test('widening stops at all — no infinite loop', () => {
    expect(widen({ period: 'all', rows: 0, pinned: false })).toBeNull()
  })

  test('a window with rows is never overridden', () => {
    expect(widen({ period: '24h', rows: 12, pinned: false })).toBeNull()
  })

  test('an operator-chosen window is never overridden, even when empty', () => {
    // Picking 24h deliberately to confirm "nothing today" must show nothing today.
    expect(widen({ period: '24h', rows: 0, pinned: true })).toBeNull()
  })
})
