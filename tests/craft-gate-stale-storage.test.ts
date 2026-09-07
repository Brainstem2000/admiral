import { test, expect, describe } from 'bun:test'

/**
 * `storage_inventory` is a SNAPSHOT, refreshed only by `view_storage`. A deposit
 * or withdrawal changes real station storage and leaves the cache untouched.
 *
 * 2026-09-07: CyberSpock deposited lead_ingot x3 at Blood Forge to craft
 * roll_lead_sheet. checkCraftInputs read the stale snapshot, answered
 * "lead_ingot: need 3, station storage has 0", and blocked. He withdrew,
 * re-deposited, retried — and was blocked with the identical message. Three full
 * cycles, ~45 minutes, and the loop could not have ended on its own because
 * doing the right thing never changed the number the guard was reading.
 *
 * A guard that fabricates a blocker is worse than no guard: this one exists to
 * save a single tick and instead burned twenty. Two independent defences, since
 * either alone would have prevented it:
 *   1. Stale cache -> stand down. The game is the authority.
 *   2. Same craft blocked twice -> stand down regardless. Never trap an agent.
 */

/** Mirrors the gate's decision. */
function craftGate(opts: {
  dirty: boolean
  need: number
  cachedHave: number
  priorKey?: string
  key: string
}): { blocked: boolean; newPrior?: string } {
  if (opts.dirty) return { blocked: false }                 // defence 1
  if (opts.cachedHave >= opts.need) return { blocked: false }
  if (opts.priorKey === opts.key) return { blocked: false }  // defence 2
  return { blocked: true, newPrior: opts.key }
}

describe('craft gate must never invent an unclearable blocker', () => {
  test('stale storage stands the gate down entirely', () => {
    // the real case: cache says 0, agent actually deposited 3
    expect(craftGate({ dirty: true, need: 3, cachedHave: 0, key: 'roll_lead_sheet:1' }).blocked)
      .toBe(false)
  })

  test('with fresh data and a genuine shortfall it still blocks once', () => {
    expect(craftGate({ dirty: false, need: 3, cachedHave: 0, key: 'roll_lead_sheet:1' }).blocked)
      .toBe(true)
  })

  test('the identical craft is never blocked twice — the loop cannot form', () => {
    const first = craftGate({ dirty: false, need: 3, cachedHave: 0, key: 'roll_lead_sheet:1' })
    expect(first.blocked).toBe(true)
    const second = craftGate({
      dirty: false, need: 3, cachedHave: 0,
      key: 'roll_lead_sheet:1', priorKey: first.newPrior,
    })
    expect(second.blocked).toBe(false)
  })

  test('a DIFFERENT craft still gets its one block', () => {
    expect(craftGate({
      dirty: false, need: 2, cachedHave: 0,
      key: 'build_rad_harvester_i:1', priorKey: 'roll_lead_sheet:1',
    }).blocked).toBe(true)
  })

  test('sufficient stock never blocks', () => {
    expect(craftGate({ dirty: false, need: 3, cachedHave: 3, key: 'roll_lead_sheet:1' }).blocked)
      .toBe(false)
  })
})
