import { describe, expect, test } from 'bun:test'
import { overlongRouteAdvice, MAX_MACRO_HOPS } from '../src/server/lib/tools'

/**
 * Cass Margin, 2026-09-02 23:23, on a 28-hop run to outerrim: "Route is too
 * long for one macro (28 hops). I need to break it into segments. Let me go to
 * First Step (jump 12, midway) first". She got there, but she had to reason it
 * out, because the abort said only "refuel/plan waypoints".
 *
 * The refusal names the waypoint, the same way READY TO CLAIM names the command
 * and JUMP LINKS names the reachable ids.
 *
 * UPDATED 2026-09-14. This file used to assert the waypoint was hop 19 of 28,
 * which pinned a bug rather than a behaviour: a leg could only fly ~13 hops
 * before the travel budget ran out, so the advised first leg could never
 * complete and agents looped on it (Ledger Voss, ~5 hours and 85 jumps). Note
 * that Cass reasoned her way to "jump 12, midway" above — the midpoint was the
 * right answer all along, and the code was the thing that disagreed.
 *
 * The hop cap is no longer the stranding guard and is not treated as one: the
 * 25% fuel reserve and the learned-map sanity check do that job on grounds that
 * do not depend on distance.
 */
const route = (n: number) => Array.from({ length: n }, (_, i) => `sys_${i + 1}`)

describe('overlongRouteAdvice', () => {
  test('names a concrete waypoint and the real destination', () => {
    const msg = overlongRouteAdvice(route(28), 'frontier')
    // Midway — reachable in one travel budget. Hop 19 was the old answer and
    // was not: the leg timed out at ~13 and the agent retried it forever.
    expect(msg).toContain('goto_system(target_system="sys_14")')   // hop 14 of 28
    expect(msg).toContain('goto_system(target_system="frontier")')
    expect(msg).toContain('28 hops')
  })

  test('tells the agent to refuel between the legs', () => {
    expect(overlongRouteAdvice(route(28), 'frontier')).toContain('REFUEL')
  })

  test('does not let the agent conclude the destination is unreachable', () => {
    const msg = overlongRouteAdvice(route(40), 'krynn')
    expect(msg).toContain('it is reachable')
    expect(msg).not.toContain('unreachable')
  })

  test('the waypoint is short of the cap so leg two still has margin', () => {
    const msg = overlongRouteAdvice(route(30), 'x')
    const hop = Number(msg.match(/hop (\d+) of/)![1])
    expect(hop).toBeLessThan(MAX_MACRO_HOPS)
    expect(hop).toBeGreaterThan(1)          // never a pointless one-hop first leg
  })

  test('a route barely over the cap still gets a sensible split', () => {
    const msg = overlongRouteAdvice(route(26), 'x')
    const hop = Number(msg.match(/hop (\d+) of/)![1])
    expect(hop).toBeGreaterThan(1)
    expect(hop).toBeLessThan(26)
  })

  test('a pathological short list does not produce an undefined waypoint', () => {
    for (const n of [1, 2, 3]) {
      const msg = overlongRouteAdvice(route(n), 'x')
      expect(msg).not.toContain('undefined')
    }
  })
})
