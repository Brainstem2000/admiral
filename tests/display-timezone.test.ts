import { describe, expect, test } from 'bun:test'
import { toISO, parseDbTime, hoursSince, formatInTz, isValidTimeZone, resolveDisplayTimeZone, DEFAULT_DISPLAY_TZ } from '../src/server/lib/time'

/**
 * The database stores UTC; JavaScript does not assume that.
 *
 * `new Date("2026-09-15 16:48:06")` — the exact shape SQLite's `datetime('now')`
 * writes — is parsed as LOCAL time, so on the operator's US Central machine it
 * resolves five hours into the future. Two staleness checks in briefing.ts were
 * built on that parse, which made `staleH` five hours short and meant the rent
 * "lapsed?" warning needed eleven real hours to fire instead of six. The fleet
 * found ~99,500 cr/week of crew-bunk rent draining out of two agents by hand on
 * 2026-09-15; the briefing that existed to flag it had been silently disarmed.
 */
describe('database timestamps are UTC', () => {
  test('a bare datetime(\'now\') string is treated as UTC, not local', () => {
    expect(toISO('2026-09-15 16:48:06')).toBe('2026-09-15T16:48:06Z')
    expect(parseDbTime('2026-09-15 16:48:06')).toBe(Date.parse('2026-09-15T16:48:06Z'))
  })

  test('rows that already carry a zone are left alone — the tables are MIXED', () => {
    // recurring_obligations is collector-written and stores ISO-with-Z, while
    // every DEFAULT (datetime('now')) column stores the bare form.
    expect(toISO('2026-09-08T16:33:19Z')).toBe('2026-09-08T16:33:19Z')
    expect(toISO('2026-09-15T16:48:06+02:00')).toBe('2026-09-15T16:48:06+02:00')
    expect(parseDbTime('2026-09-15T16:48:06+02:00')).toBe(Date.parse('2026-09-15T14:48:06Z'))
  })

  test('hoursSince measures real elapsed time regardless of the host zone', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
    expect(hoursSince(fiveHoursAgo)).toBeCloseTo(5, 1)
  })

  test('the reading is UTC no matter what zone the host is in', () => {
    // This is the invariant that matters, and it must not be expressed in terms
    // of the host offset: the test runner itself runs in UTC, where the original
    // defect is invisible (naive and correct agree, drift is exactly zero). An
    // assertion built on getTimezoneOffset() therefore passes here for the wrong
    // reason and says nothing about the Central machine the fleet runs on.
    const bare = '2026-09-15 16:48:06'
    expect(parseDbTime(bare)).toBe(Date.parse('2026-09-15T16:48:06Z'))

    // And the rendered result is pinned to a real offset rather than the host's,
    // so this fails on a Central box if the parse ever regresses to local.
    expect(formatInTz(bare, 'UTC')).toContain('16:48')
    expect(formatInTz(bare, 'America/Chicago')).toContain('11:48')
  })

  test('an unparseable timestamp yields NaN rather than a wrong number', () => {
    expect(Number.isNaN(parseDbTime(''))).toBe(true)
    expect(Number.isNaN(parseDbTime(null))).toBe(true)
    expect(Number.isNaN(hoursSince(undefined))).toBe(true)
  })
})

describe('display time zone', () => {
  test('renders a UTC timestamp in the configured zone', () => {
    // 19:39 UTC is 14:39 Central — the conversion that was reported wrong.
    expect(formatInTz('2026-09-15 19:39:00', 'America/Chicago')).toContain('14:39')
    expect(formatInTz('2026-09-15 19:39:00', 'UTC')).toContain('19:39')
  })

  test('an IANA name is required because CST and CDT differ by an hour', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    // Same wall clock, six months apart, one zone name — the offset moves.
    const summer = formatInTz('2026-07-15 19:39:00', 'America/Chicago')
    const winter = formatInTz('2026-01-15 19:39:00', 'America/Chicago')
    expect(summer).toContain('14:39')   // CDT, UTC-5
    expect(winter).toContain('13:39')   // CST, UTC-6
  })

  test('resolution order is preference, then ADMIRAL_TZ, then Central', () => {
    expect(resolveDisplayTimeZone('Europe/Berlin', 'Asia/Tokyo')).toBe('Europe/Berlin')
    expect(resolveDisplayTimeZone(null, 'Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(resolveDisplayTimeZone(null, undefined)).toBe(DEFAULT_DISPLAY_TZ)
  })

  test('a bad stored value degrades to a sane clock instead of throwing', () => {
    expect(resolveDisplayTimeZone('Mars/Olympus', undefined)).toBe(DEFAULT_DISPLAY_TZ)
    expect(() => formatInTz('2026-09-15 19:39:00', 'Mars/Olympus')).not.toThrow()
  })
})
