/**
 * Queue-aware pacing: sleep as long as the bench has work, and not a second past it.
 *
 * Brian, 2026-09-16: "I want it synced better so that there is no wasted time
 * thinking about nothing that needs thought of."
 *
 * The two failure modes this sits between, both observed the same day:
 *  - UNPACED: Morg'Thar made 2,006 LLM calls (28% of the fleet's entire usage,
 *    ~$76) while every unit he produced came from a workshop queue advancing on
 *    10-second game ticks whether he was awake or not.
 *  - PACED TOO LONG: a 19-run control-node batch is ~3 minutes. A 2-minute fixed
 *    pace would leave the bench idle between batches — output lost to save tokens.
 */
import { test, expect } from 'bun:test'
import { pacedSleepMs } from '../src/server/lib/agent'

const MIN = 60_000

test('a deep queue sleeps to the cap, not to the queue length', () => {
  // Morg's real queue on 2026-09-16 was 127 minutes deep. Sleeping all of it
  // would strand finished nodes in his locker, where a faction build cannot see
  // them — that is what stalled the first facility for half an hour.
  expect(pacedSleepMs(127 * MIN, MIN)).toBe(600_000)
})

test('a shallow queue sleeps only to the operator floor', () => {
  // 3 minutes of work minus a 2-minute requeue margin = 1 minute, which is the
  // floor anyway. The bench must never drain while the agent sleeps.
  expect(pacedSleepMs(3 * MIN, MIN)).toBe(MIN)
})

test('a medium queue sleeps to runway minus the requeue margin', () => {
  // 8 min of work: wake at 6 min, leaving 2 min to notice and requeue.
  expect(pacedSleepMs(8 * MIN, MIN)).toBe(6 * MIN)
})

test('an empty queue falls back to the operator floor', () => {
  expect(pacedSleepMs(0, MIN)).toBe(MIN)
})

test('an UNREADABLE queue falls back to the floor, never to the cap', () => {
  // "I could not read the queue" must never be treated as "there is nothing to
  // do" — that would pace a busy agent as if it were idle.
  expect(pacedSleepMs(null, MIN)).toBe(MIN)
  expect(pacedSleepMs(NaN, MIN)).toBe(MIN)
  expect(pacedSleepMs(-5, MIN)).toBe(MIN)
})

test('the operator floor is a floor, never undercut', () => {
  // Pacing is something the operator set. A short queue may not shorten it.
  const bigFloor = 5 * MIN
  expect(pacedSleepMs(2 * MIN, bigFloor)).toBe(bigFloor)
  expect(pacedSleepMs(30 * MIN, bigFloor)).toBeGreaterThanOrEqual(bigFloor)
})

test('a floor larger than the cap still wins', () => {
  // An operator who sets a 30-minute pace means it; the cap must not override.
  const floor = 30 * MIN
  expect(pacedSleepMs(120 * MIN, floor)).toBeGreaterThanOrEqual(floor)
})

test('margin and cap are tunable', () => {
  expect(pacedSleepMs(20 * MIN, MIN, { capMs: 5 * MIN })).toBe(5 * MIN)
  expect(pacedSleepMs(10 * MIN, MIN, { marginMs: 60_000 })).toBe(9 * MIN)
})

/**
 * A supplier holding stock the vault is out of must NOT be paced long, however
 * deep its own queue is.
 *
 * Morg'Thar, 2026-09-16: 123 minutes of queued work — so the queue rule paced him
 * to the 10-minute cap — while he held 51 platinum_wiring and the faction vault
 * held ZERO. Three assemblers read the vault and sat idle. He was "busy" exactly
 * because he was hoarding, and the pacing rewarded it.
 */
test('holding blocked supply overrides even a very deep queue', () => {
  expect(pacedSleepMs(123 * MIN, MIN, { holdingSupply: true })).toBe(MIN)
  expect(pacedSleepMs(999 * MIN, MIN, { holdingSupply: true })).toBe(MIN)
})

test('holding supply still respects the operator floor, never going below it', () => {
  const floor = 5 * MIN
  expect(pacedSleepMs(123 * MIN, floor, { holdingSupply: true })).toBe(floor)
})

test('not holding supply leaves the queue rule untouched', () => {
  expect(pacedSleepMs(123 * MIN, MIN, { holdingSupply: false })).toBe(600_000)
  expect(pacedSleepMs(123 * MIN, MIN)).toBe(600_000)
})
