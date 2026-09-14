import { describe, expect, test } from 'bun:test'
import { overlongRouteAdvice, MAX_MACRO_HOPS, GOTO_PER_HOP_MS, GOTO_BASE_BUDGET_MS } from '../src/server/lib/tools'

/**
 * A long journey must finish in ONE call, and any advice it gives must be
 * followable.
 *
 * goto_system carried two numbers that disagreed with reality. The hop cap said
 * 25, but a flat 12-minute budget truncated every route at about 13 hops
 * (measured median 40s/hop). So the cap was unreachable, and its only effect was
 * to push agents into a two-leg split — whose FIRST leg was aimed at hop 19 and
 * therefore also could not complete.
 *
 * Ledger Voss, 2026-09-14: told "goto segin first — that is hop 19 of 30", he
 * stopped at 13/19, re-ran, stopped again, and spent roughly five hours and 85
 * jumps without reaching either destination. Each truncation also cost a full
 * LLM turn to notice and resume, which is the real price of a PARTIAL.
 *
 * Stranding protection does not live here and never did: the 25% fuel reserve
 * check and the learned-map sanity check do that, on grounds independent of
 * distance.
 */

const route = (n: number) => Array.from({ length: n }, (_, i) => `sys_${i + 1}`)

/** The budget the macro grants a route of this length. */
const budgetMs = (hops: number) => Math.max(GOTO_BASE_BUDGET_MS, hops * GOTO_PER_HOP_MS + 120_000)
/** Hops actually completable in that budget at the measured 40s/hop. */
const reachable = (hops: number) => Math.floor(budgetMs(hops) / 40_000)

describe('travel budget scales with the route', () => {
  test('a long route is given enough time to finish in one call', () => {
    for (const n of [13, 18, 25, 30, 45, 60]) {
      expect(reachable(n)).toBeGreaterThanOrEqual(n)
    }
  })

  test('the 30-hop route that defeated Ledger now fits one budget', () => {
    expect(reachable(30)).toBeGreaterThanOrEqual(30)
    // It did not before: a flat 12 minutes bought about 18 hops at best.
    expect(Math.floor(GOTO_BASE_BUDGET_MS / 40_000)).toBeLessThan(30)
  })

  test('a short commute is not given a smaller budget than it used to have', () => {
    expect(budgetMs(2)).toBe(GOTO_BASE_BUDGET_MS)
    expect(budgetMs(8)).toBe(GOTO_BASE_BUDGET_MS)
  })

  test('the hop cap no longer bites before the budget does', () => {
    expect(MAX_MACRO_HOPS).toBeGreaterThan(30)
    expect(reachable(MAX_MACRO_HOPS)).toBeGreaterThanOrEqual(MAX_MACRO_HOPS)
  })
})

describe('overlong-route advice names a waypoint that is actually reachable', () => {
  test('the first leg fits inside one travel budget', () => {
    for (const n of [62, 80, 120]) {
      const msg = overlongRouteAdvice(route(n), 'far_away')
      const m = msg.match(/that is hop (\d+) of (\d+)/)
      expect(m).not.toBeNull()
      const legHops = Number(m![1])
      // The whole bug: leg one has to be completable, or the agent loops on it.
      expect(legHops).toBeLessThanOrEqual(reachable(legHops))
    }
  })

  test('it splits near the middle rather than pinning hop 19', () => {
    const msg = overlongRouteAdvice(route(80), 'far_away')
    const legHops = Number(msg.match(/that is hop (\d+) of/)![1])
    expect(legHops).toBeGreaterThan(30)   // hop 19 was the old, unreachable answer
    expect(legHops).toBeLessThan(50)
  })

  test('a route only just over the cap does not produce a one-hop first leg', () => {
    const msg = overlongRouteAdvice(route(MAX_MACRO_HOPS + 2), 'far_away')
    expect(Number(msg.match(/that is hop (\d+) of/)![1])).toBeGreaterThan(1)
  })

  test('the waypoint is a real system from the route, and not the destination', () => {
    const r = route(70)
    const msg = overlongRouteAdvice(r, 'far_away')
    const named = msg.match(/target_system="([^"]+)"\) first/)![1]
    expect(r).toContain(named)
    expect(named).not.toBe(r[r.length - 1])
  })
})
