/**
 * "Is this agent hoarding a shared input?" — the test that decides whether a
 * busy-looking agent should still be paced short.
 *
 * A faction build and `craft source="faction"` both read the VAULT and never a
 * personal locker, so stock in a locker is stock nobody else can use. An agent
 * sitting on it is not productive, it is a bottleneck — however deep its own
 * craft queue is.
 *
 * The first version fired only when the vault was at literal ZERO and missed the
 * real case by a hair: on 2026-09-16 the vault held 12 platinum_wiring while
 * Morg'Thar held 86, so he paced to the 10-minute cap while three assemblers
 * shared 12 units between them.
 */
import { test, expect } from 'bun:test'

/** Mirrors the predicate in Agent.holdingBlockedSupply. */
function isHoarding(holding: number, inVault: number, min = 20): boolean {
  if (holding < min) return false
  return inVault * 2 < holding
}

test('the case that slipped through: vault 12, agent 86', () => {
  expect(isHoarding(86, 12)).toBe(true)
})

test('an empty vault still fires', () => {
  expect(isHoarding(51, 0)).toBe(true)
})

test('a well-supplied vault does NOT fire, even when the agent holds more', () => {
  // 600 vs 500 is not a blockage — everyone can work. Firing here would pace
  // every producer to the floor and undo the whole token saving.
  expect(isHoarding(600, 500)).toBe(false)
  expect(isHoarding(100, 60)).toBe(false)
})

test('the ratio is scale-free across items spanning three orders of magnitude', () => {
  // 86 wiring against 12 in the vault is a hoard...
  expect(isHoarding(86, 12)).toBe(true)
  // ...while 86 steel_plate against 140 is a rounding error on a 2,850 bill.
  expect(isHoarding(86, 140)).toBe(false)
})

test('a small working remainder is never a hoard', () => {
  // Crafters are told to keep ~20 for their own use; that must not trip this.
  expect(isHoarding(19, 0)).toBe(false)
  expect(isHoarding(20, 0)).toBe(true)
})

test('exactly at the boundary, the vault holding half does not fire', () => {
  // vault*2 < holding — 43*2 = 86 is not < 86.
  expect(isHoarding(86, 43)).toBe(false)
  expect(isHoarding(86, 42)).toBe(true)
})
