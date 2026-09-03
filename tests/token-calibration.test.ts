import { describe, expect, test } from 'bun:test'
import { recordTokenCalibration, calibrationFor } from '../src/server/lib/loop'

/**
 * A fixed chars-per-token constant is a guess, and a wrong guess silently
 * breaks compaction.
 *
 * CyberSpock (2026-09-02): compaction ran correctly and reported the context at
 * ~42,500 estimated tokens, while the provider charged 182,114 for the very
 * same prompt — a 4.3x under-count. The budget was computed against a fiction,
 * so compaction "succeeded" and the next call still blew the 131,072 window.
 *
 * Every completed call carries ground truth next to our estimate, so the ratio
 * is measurable. This calibrates per model, works for any provider, and needs
 * no constant to be maintained by hand.
 */
describe('token calibration', () => {
  test('an uncalibrated model is trusted at face value', () => {
    expect(calibrationFor('brand-new-model')).toBe(1)
    expect(calibrationFor(undefined)).toBe(1)
  })

  test('a large under-count is learned, and converges toward the truth', () => {
    const m = `m-under-${Math.random()}`
    // The real observation: we said 42,500, the provider charged 182,114 (4.29x).
    let cal = 0
    for (let i = 0; i < 12; i++) cal = recordTokenCalibration(m, 42_500, 182_114)
    expect(cal).toBeGreaterThan(4)
    expect(cal).toBeLessThanOrEqual(4.3)
  })

  test('one odd call cannot swing the budget wildly', () => {
    const m = `m-spike-${Math.random()}`
    recordTokenCalibration(m, 10_000, 10_000)          // settled at ~1
    const after = recordTokenCalibration(m, 10_000, 80_000)  // one 8x outlier
    expect(after).toBeLessThan(4)                       // smoothed, not adopted whole
    expect(after).toBeGreaterThan(1)                    // but it did move
  })

  test('the factor is clamped so a bad reading cannot make the budget absurd', () => {
    const m = `m-clamp-${Math.random()}`
    for (let i = 0; i < 40; i++) recordTokenCalibration(m, 1, 1_000_000)
    expect(calibrationFor(m)).toBeLessThanOrEqual(8)
    const m2 = `m-clamp2-${Math.random()}`
    for (let i = 0; i < 40; i++) recordTokenCalibration(m2, 1_000_000, 1)
    expect(calibrationFor(m2)).toBeGreaterThanOrEqual(0.5)
  })

  test('garbage observations are ignored rather than poisoning the factor', () => {
    const m = `m-junk-${Math.random()}`
    recordTokenCalibration(m, 0, 5000)
    recordTokenCalibration(m, 5000, 0)
    recordTokenCalibration(m, -1, -1)
    expect(calibrationFor(m)).toBe(1)
  })

  test('models are calibrated independently', () => {
    const a = `m-a-${Math.random()}`, b = `m-b-${Math.random()}`
    for (let i = 0; i < 12; i++) recordTokenCalibration(a, 1000, 4000)
    expect(calibrationFor(a)).toBeGreaterThan(3)
    expect(calibrationFor(b)).toBe(1)
  })
})
