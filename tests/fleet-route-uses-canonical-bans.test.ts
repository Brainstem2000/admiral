import { describe, expect, test } from 'bun:test'

/**
 * fleet_route is the routing fallback agents are told to use when the game's find_route
 * offers a banned path. It once hard-coded `new Set(['goldcrest','bluerift'])`, a subset
 * of the real list, and routed Grit Vane through systems on the ban list (2026-09-17).
 * The lesson holds after the list became LEARNED (2026-09-18): every code path must read
 * the one canonical Set, and no path may carry its own literal copy.
 */
const SRC = await Bun.file('src/server/lib/tools.ts').text()

describe('every routing path reads the one learned ban list', () => {
  test('each FORBIDDEN binding references the canonical set, never a literal', () => {
    const lines = SRC.split('\n').filter((l) => /const FORBIDDEN =/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain('FORBIDDEN_SYSTEMS')
      expect(line).not.toMatch(/new Set\(\s*\[/)
    }
  })

  test('the tool description states the learned rule and names no hardcoded system', () => {
    const i = SRC.indexOf("name: 'fleet_route'")
    expect(i).toBeGreaterThan(-1)
    const desc = SRC.slice(i, i + 900)
    expect(desc).toContain('capital ship')
    expect(desc).toMatch(/tier 4 or 5/)
    for (const old of ['ross_248', 'goldcrest', 'bluerift', 'xamidimura', 'sadalmelik']) {
      expect(desc).not.toContain(old)
    }
  })
})
