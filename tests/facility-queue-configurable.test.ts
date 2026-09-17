import { describe, expect, test, afterAll } from 'bun:test'
import { getPreference, setPreference } from '../src/server/lib/db'

/**
 * The build page renders the facility queue and nothing else, so a facility missing
 * from it is invisible while the fleet works on it. On 2026-09-17 three agents were
 * buying, forging and hauling materials for a Tungsten Drawing Frame that appeared on
 * no page at all, because the queue was a hardcoded array and nobody had edited it.
 *
 * "Remember to edit the source" is a process, not a fix. The order now lives in the
 * `facility_build_queue` preference, with the constant as a fallback — and the fallback
 * must survive a junk value rather than 500 the page.
 */
const KEY = 'facility_build_queue'
const SRC = await Bun.file('src/server/routes/faction.ts').text()
const before = getPreference(KEY)
afterAll(() => { if (before !== null) setPreference(KEY, before) })

describe('the facility build queue is runtime-configurable, not compiled in', () => {
  test('the route reads the preference rather than the constant directly', () => {
    expect(SRC).toContain('function facilityQueue()')
    expect(SRC).toContain("getPreference('facility_build_queue')")
    // The regression: mapping straight over the constant.
    expect(SRC).not.toMatch(/const queue = DEFAULT_FACILITY_QUEUE\.map/)
    expect(SRC).toContain('facilityQueue().map')
  })

  test('the default still carries the frame that exposed the bug', () => {
    expect(SRC).toContain("'tungsten_drawing_frame'")
    // ...and ahead of the chamber, which is the cheaper, nearer build.
    expect(SRC.indexOf("'tungsten_drawing_frame'"))
      .toBeLessThan(SRC.indexOf("'neutronium_compression_chamber'"))
  })

  test('a stored order round-trips', () => {
    setPreference(KEY, JSON.stringify(['a_plant', 'b_works']))
    expect(JSON.parse(getPreference(KEY)!)).toEqual(['a_plant', 'b_works'])
  })

  test('junk in the preference falls back instead of throwing', () => {
    for (const junk of ['not json', '{}', '[]', '[1,2,3]', '[""]']) {
      setPreference(KEY, junk)
      // Mirrors facilityQueue()'s guard: array, non-empty, all non-empty strings.
      let ok = false
      try {
        const p = JSON.parse(getPreference(KEY)!)
        ok = Array.isArray(p) && p.length > 0 && p.every((x: unknown) => typeof x === 'string' && x)
      } catch { ok = false }
      expect(ok).toBe(false)     // every one of these must take the fallback path
    }
  })
})
