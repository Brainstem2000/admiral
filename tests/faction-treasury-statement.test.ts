/**
 * The treasury statement must account for money the GAME never reports.
 *
 * Facility rent is auto-deducted every ~17-minute cycle and never comes back as a
 * command result, so a ledger built only from command results silently loses the
 * biggest recurring outflow — on 2026-09-16 the faction treasury had drained
 * ~193,000 credits with no booked row to point at. These tests pin the
 * reconstruction: difference the balances the game DID state, subtract what we
 * booked, and surface the remainder rather than hiding it.
 */
import { test, expect, beforeEach } from 'bun:test'
import { getDb, getFactionTreasuryStatement, insertFactionLedger, recordFactionTreasurySnapshot } from '../src/server/lib/db'

beforeEach(() => {
  const d = getDb()
  d.exec('DELETE FROM faction_ledger')
  d.exec('DELETE FROM faction_treasury_snapshots')
})

const snap = (credits: number, at: string) =>
  getDb().query('INSERT INTO faction_treasury_snapshots (faction_id, credits, at, reported_by) VALUES (?,?,?,?)')
    .run('f1', credits, at, 'tester')

const booked = (credits: number, at: string, kind = 'treasury_withdraw') =>
  insertFactionLedger({
    faction_id: 'f1', faction_tag: 'F', kind: kind as never, profile_id: null, station_id: null,
    item_id: null, quantity: null, credits_signed: credits, source_command: 'test',
    raw_ref: null, tick: null, dedupe_key: `${kind}:${credits}:${at}`, timestamp: at,
  })

test('an unexplained drop between two stated balances becomes its own line', () => {
  snap(100_000, '2026-09-16 10:00:00')
  snap(99_000, '2026-09-16 10:17:00')
  const st = getFactionTreasuryStatement({})
  const gap = st.entries.filter(e => e.inferred)
  expect(gap.length).toBe(1)
  expect(gap[0].credits).toBe(-1000)
  expect(gap[0].balance_after).toBe(99_000)
})

test('a booked movement explains the drop and leaves nothing inferred', () => {
  snap(100_000, '2026-09-16 10:00:00')
  booked(-1000, '2026-09-16 10:05:00')
  snap(99_000, '2026-09-16 10:17:00')
  const st = getFactionTreasuryStatement({})
  expect(st.entries.filter(e => e.inferred).length).toBe(0)
  expect(st.entries.filter(e => !e.inferred).length).toBe(1)
})

test('a repeating small outflow is identified as facility rent, not left unattributed', () => {
  let bal = 100_000
  snap(bal, '2026-09-16 10:00:00')
  // four identical cycles — rent bills at a fixed rate on a fixed cadence
  for (const t of ['10:17', '10:34', '10:51', '11:08']) { bal -= 664; snap(bal, `2026-09-16 ${t}:00`) }
  const st = getFactionTreasuryStatement({})
  const rent = st.entries.filter(e => e.kind === 'facility_rent')
  expect(rent.length).toBe(4)
  expect(st.totals.rent).toBe(-2656)
  expect(st.totals.rent_cycles).toBe(4)
  // a one-off big spend must NOT be mislabelled as rent
  expect(rent.every(e => e.credits === -664)).toBe(true)
})

test('a one-off large drop stays unattributed even alongside rent', () => {
  let bal = 1_000_000
  snap(bal, '2026-09-16 10:00:00')
  for (const t of ['10:17', '10:34', '10:51']) { bal -= 664; snap(bal, `2026-09-16 ${t}:00`) }
  bal -= 600_000; snap(bal, '2026-09-16 11:08:00')
  const st = getFactionTreasuryStatement({})
  const big = st.entries.find(e => e.credits === -600_000)
  expect(big).toBeDefined()
  expect(big!.kind).toBe('unattributed_outflow')
  expect(st.totals.rent).toBe(-1992)
})

test('duplicate snapshots of the same balance do not create phantom lines', () => {
  snap(50_000, '2026-09-16 10:00:00')
  snap(50_000, '2026-09-16 10:00:00')
  snap(50_000, '2026-09-16 10:00:00')
  const st = getFactionTreasuryStatement({})
  expect(st.entries.length).toBe(0)
  expect(st.closing?.credits).toBe(50_000)
})

test('the running balance re-anchors to what the game actually stated', () => {
  snap(10_000, '2026-09-16 10:00:00')
  snap(7_500, '2026-09-16 10:17:00')
  const st = getFactionTreasuryStatement({})
  expect(st.opening?.credits).toBe(10_000)
  expect(st.entries[st.entries.length - 1].balance_after).toBe(7_500)
})

test('rent accrued across a long gap is recognised as N cycles, not left unattributed', () => {
  let bal = 500_000
  snap(bal, '2026-09-16 10:00:00')
  // establish the per-cycle rate
  for (const t of ['10:17', '10:34', '10:51']) { bal -= 664; snap(bal, `2026-09-16 ${t}:00`) }
  // then a 51-cycle overnight gap where nobody queried the balance
  bal -= 664 * 51; snap(bal, '2026-09-17 01:00:00')
  const st = getFactionTreasuryStatement({})
  const batch = st.entries.find(e => e.credits === -664 * 51)
  expect(batch).toBeDefined()
  expect(batch!.kind).toBe('facility_rent')
  expect(batch!.reason).toContain('51 cycles')
  expect(st.totals.rent).toBe(-664 * 54)
})

test('a spend that is not a multiple of the rent rate stays unattributed', () => {
  let bal = 900_000
  snap(bal, '2026-09-16 10:00:00')
  for (const t of ['10:17', '10:34', '10:51']) { bal -= 664; snap(bal, `2026-09-16 ${t}:00`) }
  bal -= 151_000; snap(bal, '2026-09-16 11:08:00')   // a facility build, not rent
  const st = getFactionTreasuryStatement({})
  expect(st.entries.find(e => e.credits === -151_000)!.kind).toBe('unattributed_outflow')
})
