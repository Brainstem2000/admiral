import { describe, expect, test } from 'bun:test'
import { classify } from '../scripts/verify-ledger'

/**
 * The server writes the SAME movement several different ways, and the first version of
 * this classifier knew only one of them — it flagged 341 real "Deposited N x item to
 * faction storage" lines as unparsed. Every shape below was counted in the live logs on
 * 2026-09-17; this file pins them so a future edit cannot silently narrow the parser
 * again. The direction cases matter most: reading a withdrawal as a deposit moves the
 * totals in the flattering direction and nothing else in the pipeline would catch it.
 */
const T = '2026-09-18T03:35:38Z'
const item = (s: string) => { const c = classify(T, s); expect(c.kind).toBe('item'); return (c as any).transfer }

describe('faction action-log classifier', () => {
  test('both deposit wordings are deposits', () => {
    expect(item('Deposited 341 x steel_plate to faction storage')).toMatchObject({ item: 'steel_plate', qty: 341, toFaction: true })
    expect(item('Transferred 222 x weapon_core from personal storage to faction main storage')).toMatchObject({ item: 'weapon_core', qty: 222, toFaction: true })
  })

  test('both withdrawal wordings are withdrawals, not deposits', () => {
    expect(item('Withdrew 88 x iron_ore from faction storage').toFaction).toBe(false)
    expect(item('Transferred 81 x copper_ore from faction main storage to personal storage').toFaction).toBe(false)
  })

  test('direction is read from which side says "faction", not from word order', () => {
    expect(item('Transferred 5 x gold_ore from faction main storage to personal storage').toFaction).toBe(false)
    expect(item('Transferred 5 x gold_ore from personal storage to faction main storage').toFaction).toBe(true)
  })

  test('thousands separators survive', () => {
    expect(item('Deposited 1,450 x copper_ore to faction storage').qty).toBe(1450)
  })

  test('package ids carry a colon and must still parse', () => {
    expect(item('Deposited 1 x package:b5c24f28577db5b1050ffbbe48d83e2c to faction storage').item)
      .toBe('package:b5c24f28577db5b1050ffbbe48d83e2c')
  })

  test('credits are treasury, never stock', () => {
    for (const s of ['Deposited 5000 credits to faction treasury', 'Withdrew 200 credits from faction treasury',
                     'Earned 96 credits — VeraLane_Zibal paid for refuel at your station'])
      expect(classify(T, s).kind).toBe('credits')
  })

  test('bulk transfers are flagged as bulk — the server gives no per-item quantity to verify', () => {
    expect(classify(T, 'Transferred 15 item types (289 units) in bulk from personal storage to faction storage').kind).toBe('bulk')
  })

  test('membership and build events are admin, not movements', () => {
    for (const s of ['Invited UMan to Stellar Alliance', "Changed CyberSpock's role to officer in Stellar Alliance",
                     'Joined faction Stellar Alliance', 'Built Polonium Doping Cell for 250000 credits'])
      expect(classify(T, s).kind).toBe('admin')
  })

  test('anything genuinely unrecognised is reported, never silently treated as a movement', () => {
    expect(classify(T, 'Something the server started saying last patch').kind).toBe('unknown')
    expect(classify(T, 'Transferred 0 x steel_plate from personal storage to faction main storage').kind).toBe('unknown')
  })
})
