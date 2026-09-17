/**
 * Treasury credits move through the transfer API as an ITEM named "credits" —
 * the game refuses a bare `credits` argument with
 *   "item_id is required for transfer. Use item_id=\"credits\""
 * so a treasury draw is spelled withdraw{source:faction, item_id:"credits", quantity:N}.
 *
 * Booking that as lockbox stock lost 1,900,000 credits of real withdrawals across
 * three draws on 2026-09-15 (400k + 900k + 600k). They landed with credits_signed
 * NULL, so the treasury statement could not attribute them and reported the money
 * as "unattributed outflow" — and the vault would have listed "credits" as an item
 * anyone could try to withdraw.
 */
import { test, expect, beforeEach } from 'bun:test'
import { getDb } from '../src/server/lib/db'
import { captureFactionFromCommand } from '../src/server/lib/faction-ledger'

beforeEach(() => { getDb().exec('DELETE FROM faction_ledger') })

const rows = () => getDb().query('SELECT kind, item_id, quantity, credits_signed FROM faction_ledger ORDER BY id').all() as Array<{
  kind: string; item_id: string | null; quantity: number | null; credits_signed: number | null }>

test('withdrawing credits from the faction books a treasury_withdraw, not lockbox stock', () => {
  captureFactionFromCommand(
    'withdraw', { source: 'faction', item_id: 'credits', quantity: 900_000 },
    { action: 'transfer', source: 'faction', destination: 'self', item_id: 'credits', quantity: 900_000, faction_id: 'f1', base_id: 'crimson_war_citadel' },
    'p1', 'Morg', {},
  )
  const r = rows()
  expect(r.length).toBe(1)
  expect(r[0].kind).toBe('treasury_withdraw')
  expect(r[0].credits_signed).toBe(-900_000)
  expect(r[0].item_id).toBeNull()          // never stock
})

test('depositing credits to the faction books a treasury_deposit', () => {
  captureFactionFromCommand(
    'deposit', { target: 'faction', item_id: 'credits', quantity: 250_000 },
    { action: 'transfer', source: 'self', destination: 'faction', item_id: 'credits', quantity: 250_000, faction_id: 'f1', base_id: 'crimson_war_citadel' },
    'p1', 'Morg', {},
  )
  const r = rows()
  expect(r[0].kind).toBe('treasury_deposit')
  expect(r[0].credits_signed).toBe(250_000)
  expect(r[0].item_id).toBeNull()
})

test('a real item is still booked as lockbox stock, with no credits_signed', () => {
  captureFactionFromCommand(
    'withdraw', { source: 'faction', item_id: 'steel_plate', quantity: 511 },
    { action: 'transfer', source: 'faction', destination: 'self', item_id: 'steel_plate', quantity: 511, faction_id: 'f1', base_id: 'crimson_war_citadel' },
    'p1', 'Morg', {},
  )
  const r = rows()
  expect(r[0].kind).toBe('lockbox_withdraw')
  expect(r[0].item_id).toBe('steel_plate')
  expect(r[0].quantity).toBe(-511)
  expect(r[0].credits_signed).toBeNull()
})

test('CREDITS in any casing is still money, not stock', () => {
  captureFactionFromCommand(
    'withdraw', { source: 'faction', item_id: 'CREDITS', quantity: 1000 },
    { action: 'transfer', source: 'faction', destination: 'self', item_id: 'CREDITS', quantity: 1000, faction_id: 'f1' },
    'p1', 'Morg', {},
  )
  expect(rows()[0].kind).toBe('treasury_withdraw')
  expect(rows()[0].credits_signed).toBe(-1000)
})
