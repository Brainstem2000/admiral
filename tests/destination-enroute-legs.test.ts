import { test, expect, describe } from 'bun:test'

/**
 * The destination gate blocked agents from reaching their own destination.
 *
 * It exists to stop the dock -> read board -> re-route loop, and it works: it
 * turned Grit Vane's oscillation into 49 units of ore in four minutes. But the
 * `goto_system` path refused ANY target other than the committed one inside the
 * commit window — including the legs of the route to that very system.
 *
 * On 2026-09-06 Rook Vance committed to krynn to collect a rad harvester and
 * had propus and the_telescope refused as diversions, eight times in six
 * minutes. He diagnosed it correctly himself: "the macro is fixated on my
 * original krynn destination." `checkRawJumpCommit` already had the right
 * guard — it only refuses when you are STANDING IN the committed system — but
 * the macro path never got one.
 *
 * Fix: a hop strictly closer to the committed system is progress, and passes
 * WITHOUT rewriting the commitment. Rewriting it to each waypoint would reset
 * the timer at every leg and make the gate meaningless.
 */

type Graph = Record<string, string[]>
const GRAPH: Graph = {
  first_step: ['propus', 'the_telescope'],
  propus: ['first_step', 'the_telescope'],
  the_telescope: ['propus', 'first_step', 'krynn'],
  krynn: ['the_telescope', 'iron_reach'],
  iron_reach: ['krynn'],
  nashira: ['first_step'],          // away from krynn
}
/** Mirrors hopsFrom(): BFS out from an origin over the learned jump graph. */
function hopsFrom(origin: string, maxDepth = 12): Map<string, number> {
  const d = new Map([[origin, 0]])
  let frontier = [origin]
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = []
    for (const s of frontier) for (const n of GRAPH[s] ?? []) {
      if (!d.has(n)) { d.set(n, depth); next.push(n) }
    }
    frontier = next
  }
  return d
}
function movesTowardCommitment(here: string, target: string, committed: string): boolean {
  if (!target || !committed || target === committed) return false
  if (!here) return false
  const d = hopsFrom(committed)
  const dHere = d.get(here), dTarget = d.get(target)
  if (dHere === undefined || dTarget === undefined) return false
  return dTarget < dHere
}

describe("the legs of the committed route pass", () => {
  test("Rook's exact case: first_step -> the_telescope while committed to krynn", () => {
    expect(movesTowardCommitment('first_step', 'the_telescope', 'krynn')).toBe(true)
  })
  test('and the next leg from there', () => {
    expect(movesTowardCommitment('the_telescope', 'krynn', 'krynn')).toBe(false) // same target: gate not engaged
    expect(movesTowardCommitment('propus', 'the_telescope', 'krynn')).toBe(true)
  })
})

describe('a genuine diversion is still refused', () => {
  test('a hop that increases the distance does not pass', () => {
    expect(movesTowardCommitment('first_step', 'nashira', 'krynn')).toBe(false)
  })
  test('a sideways hop at the same distance does not pass', () => {
    // propus and the_telescope are both reachable from first_step, but only one
    // is closer to krynn. Equal distance is not progress.
    expect(hopsFrom('krynn').get('propus')).toBe(hopsFrom('krynn').get('first_step'))
    expect(movesTowardCommitment('first_step', 'propus', 'krynn')).toBe(false)
  })
  test('an unknown system leaves the gate standing — never fail open', () => {
    expect(movesTowardCommitment('first_step', 'somewhere_uncharted', 'krynn')).toBe(false)
    expect(movesTowardCommitment('uncharted_here', 'propus', 'krynn')).toBe(false)
  })
})

describe('the commitment must not follow the waypoints', () => {
  test('each leg is measured against the FINAL destination, not the last hop', () => {
    // Walking the route: every step is judged against krynn.
    const legs = [['first_step', 'the_telescope'], ['the_telescope', 'krynn']]
    for (const [here, next] of legs) {
      const ok = next === 'krynn' || movesTowardCommitment(here, next, 'krynn')
      expect(ok).toBe(true)
    }
  })
})
