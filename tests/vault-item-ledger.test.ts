import { describe, expect, test } from 'bun:test'
import { toUtcDate, formatStamp } from '../src/frontend/src/lib/displayTime'

/**
 * The vault item ledger, and the two ways it could quietly lie.
 *
 * 1. SIGN. `faction_ledger` stores `quantity` as a MAGNITUDE and puts the direction in
 *    `kind` (lockbox_deposit / lockbox_withdraw). Anything that sums `quantity` therefore
 *    adds withdrawals to deposits. On 2026-09-17 the real book was 127,250 in and 18,597
 *    out — an unsigned sum reports 145,847 deposited and a net that is 37,194 too high.
 *
 * 2. ZONE. The table writes bare "2026-09-18 03:11:58" with no marker. `new Date()` on
 *    that string parses it as LOCAL in every browser, so a naive render shows a
 *    plausible-looking clock that is wrong by the whole UTC offset — which is exactly
 *    what Brian kept reading off the page.
 */
const sign = (kind: string, quantity: number) =>
  String(kind).includes('withdraw') ? -Math.abs(quantity) : Math.abs(quantity)

describe('vault ledger signing', () => {
  const rows = [
    { kind: 'lockbox_deposit', quantity: 1430 },
    { kind: 'lockbox_withdraw', quantity: 700 },
    { kind: 'lockbox_deposit', quantity: 256 },
  ]
  test('withdrawals subtract, they do not add', () => {
    const net = rows.reduce((n, r) => n + sign(r.kind, r.quantity), 0)
    expect(net).toBe(986)
    // The bug this guards: summing the raw magnitude.
    expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(2386)
  })
  test('a magnitude stored negative is still a withdrawal, not a deposit', () => {
    expect(sign('lockbox_withdraw', -700)).toBe(-700)
  })
  test('deposits and withdrawals split cleanly for the in/out columns', () => {
    const d = rows.map(r => sign(r.kind, r.quantity))
    expect(d.filter(x => x > 0).reduce((a, b) => a + b, 0)).toBe(1686)
    expect(d.filter(x => x < 0).reduce((a, b) => a - b, 0)).toBe(700)
  })
})

describe('stored timestamps are UTC even without a marker', () => {
  test('a bare stamp is read as UTC, not as browser-local', () => {
    expect(toUtcDate('2026-09-18 03:11:58')!.toISOString()).toBe('2026-09-18T03:11:58.000Z')
  })
  test('an already-zoned stamp is left alone', () => {
    expect(toUtcDate('2026-09-18T03:11:58Z')!.toISOString()).toBe('2026-09-18T03:11:58.000Z')
    expect(toUtcDate('2026-09-18T03:11:58+00:00')!.toISOString()).toBe('2026-09-18T03:11:58.000Z')
  })
  test('03:11 UTC renders as the previous evening in Central — the five hours that were missing', () => {
    const s = formatStamp('2026-09-18 03:11:58', 'America/Chicago')
    expect(s).toContain('Sep 17')
    expect(s).toContain('10:11')
  })
  test('the zone is honoured, not hardcoded to Central', () => {
    expect(formatStamp('2026-09-18 03:11:58', 'UTC')).toContain('Sep 18')
  })
  test('unusable input degrades to a dash rather than throwing or showing Invalid Date', () => {
    expect(formatStamp(null, 'America/Chicago')).toBe('—')
    expect(formatStamp('not a date', 'America/Chicago')).toBe('—')
  })
  test('an invalid zone falls back instead of blanking the column', () => {
    expect(formatStamp('2026-09-18 03:11:58', 'Not/AZone')).toContain('Sep 17')
  })
})
