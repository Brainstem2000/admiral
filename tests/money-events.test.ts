import { describe, expect, test } from 'bun:test'
import { moneyRow } from '../src/server/lib/action-log'

/**
 * Money the game takes on its own clock — taxes, rent, bounty settlements,
 * facility bills — is charged between commands, so the next command to report a
 * balance used to absorb the whole gap as one "unexplained" row. Ledger Voss's
 * weekly assessment on 2026-09-13 surfaced as "-310,449, refuel". These are the
 * shapes the game's action log actually emits, taken from production rows.
 */
const evt = (event_type: string, data: Record<string, unknown>) =>
  ({ event_id: 1, created_at: '2026-09-13T21:49:21Z', category: 'other', event_type, data })

describe('money events booked from the action log', () => {
  test('income tax books what was PAID, not what was owed', () => {
    // A treasury-short empire can bill 342 and collect 17; only the 17 left the wallet.
    expect(moneyRow(evt('tax.income_paid', { empire: 'voidborn', income: 5715, owed: 342, paid: 17, unpaid: 325 })))
      .toEqual({ kind: 'tax_income', amount: -17, counterparty: 'voidborn' })
    expect(moneyRow(evt('tax.income_paid', { empire: 'solarian', income: 3043826, owed: 305759, paid: 305759, unpaid: 0 })))
      .toEqual({ kind: 'tax_income', amount: -305759, counterparty: 'solarian' })
  })

  test('property tax, rent and facility bills each get their own kind', () => {
    expect(moneyRow(evt('tax.property_paid', { empire: 'nebula', owed: 1415, paid: 1415, value: 566318 })))
      .toEqual({ kind: 'tax_property', amount: -1415, counterparty: 'nebula' })
    expect(moneyRow(evt('other.rent_paid', { base_id: 'grand_exchange_station', cost: 148, cycles: 1, facility: 'Crew Bunk' })))
      .toEqual({ kind: 'rent', amount: -148, counterparty: 'Crew Bunk' })
    expect(moneyRow(evt('other.facility_restored', { base_id: 'grand_exchange_station', cost: 6498, facility: 'Crew Bunk' })))
      .toEqual({ kind: 'facility', amount: -6498, counterparty: 'Crew Bunk' })
  })

  test('a prepayment leaves the wallet and its refund comes back', () => {
    expect(moneyRow(evt('tax.prepaid', { amount: 131, tax_prepaid_balance: 131 })))
      .toEqual({ kind: 'tax_prepaid', amount: -131, counterparty: null })
    expect(moneyRow(evt('tax.prepay_refunded', { amount: 97 })))
      .toEqual({ kind: 'tax_refund', amount: 97, counterparty: null })
  })

  test('a bounty settled from the wallet is booked; a released bond is not', () => {
    expect(moneyRow(evt('bounty.paid', { amount: 11797, empire: 'crimson', paid_from: 'wallet', released: true })))
      .toEqual({ kind: 'bounty_paid', amount: -11797, counterparty: 'crimson' })
    expect(moneyRow(evt('bounty.paid', { amount: 11797, empire: 'crimson', paid_from: 'bond', released: true }))).toBeNull()
  })

  test('events that move no credits, and zero amounts, book nothing', () => {
    expect(moneyRow(evt('mining.yield', { resource_id: 'iron_ore', quantity: 40 }))).toBeNull()
    expect(moneyRow(evt('other.jettison', { item_id: 'iron_ore', quantity: 240 }))).toBeNull()
    expect(moneyRow(evt('tax.income_paid', { empire: 'crimson', owed: 500, paid: 0, unpaid: 500 }))).toBeNull()
    expect(moneyRow(evt('other.rent_paid', { base_id: 'x', facility: 'Crew Bunk' }))).toBeNull()
  })
})
