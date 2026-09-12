import { describe, expect, test } from 'bun:test'
import { sanitizeCondition } from '../src/server/lib/plan-queue'

/**
 * A plan step condition written in the wrong shape must be refused at the API,
 * not stored: an object under `result_matches` (2026-09-11) reached the evaluator,
 * which called .toLowerCase() on it, and every plan read for that profile was a
 * 500 until the row was repaired by hand.
 */
describe('plan condition sanitizer', () => {
  test('documented shapes pass through unchanged', () => {
    const c = { docked_at: 'crimson_war_citadel', after: '2026-09-12T05:12:00Z', result_matches: 'COMPLETE', wallet_at_least: 5, docked: true,
      storage_at_least: { station_id: 's', item_id: 'i', qty: 2 }, cargo_at_least: { item_id: 'i', qty: '3' } }
    const r = sanitizeCondition(c)
    expect(r.rejected).toEqual([])
    expect(r.cond).toEqual({ ...c, cargo_at_least: { item_id: 'i', qty: 3 } })
  })
  test('an object where a substring belongs is rejected by name', () => {
    const r = sanitizeCondition({ docked_at: 'x', result_matches: { command: 'commission_status', pattern: 'COMPLETE' } })
    expect(r.rejected).toEqual(['result_matches'])
    expect(r.cond).toEqual({ docked_at: 'x' })
  })
  test('a bad time, a non-boolean flag and a malformed threshold are rejected', () => {
    const r = sanitizeCondition({ after: 'tonight', docked: 'yes', storage_at_least: { item_id: 'i' } })
    expect(r.rejected.sort()).toEqual(['after', 'docked', 'storage_at_least'])
    expect(r.cond).toBeNull()
  })
  test('nothing in, nothing out', () => {
    expect(sanitizeCondition(undefined)).toEqual({ cond: null, rejected: [] })
    expect(sanitizeCondition('x').rejected).toEqual(['condition'])
  })
})
