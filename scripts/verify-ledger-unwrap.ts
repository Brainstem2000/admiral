/**
 * Verify the lib_v2 ledger fix: a mutation result shaped like the lib's state
 * DELTA (payload nested at delta.details) must book a ledger row.
 * Uses a throwaway profile id; cleans up after itself.
 *
 * Usage: bun run scripts/verify-ledger-unwrap.ts
 */
import { LedgerCollector } from '../src/server/lib/ledger'
import { getDb } from '../src/server/lib/db'

const FAKE = 'test-ledger-verify'

// Shape a lib_v2 sell: CommandResult.structuredContent = delta { player, ship, details }
const delta = {
  player: { credits: 12345 },
  ship: { cargo_used: 10 },
  details: {
    action: 'sell',
    item_id: 'copper_ore',
    quantity_sold: 23,
    total_earned: 460,
    fills: [{ price_each: 20, quantity: 23, counterparty: 'Test Station' }],
  },
}

LedgerCollector.processCommandResult('sell', delta, FAKE, 'TestAgent')

const db = getDb()
const rows = db.query(`SELECT kind, item_id, quantity, unit_price, amount_signed FROM financial_ledger WHERE profile_id = ?`).all(FAKE) as Record<string, unknown>[]
console.log(`rows booked for fake profile: ${rows.length}`)
for (const r of rows) console.log(' ', JSON.stringify(r))

const ok = rows.length === 1 && rows[0].kind === 'sell' && rows[0].amount_signed === 460 && rows[0].item_id === 'copper_ore'
db.run(`DELETE FROM financial_ledger WHERE profile_id = ?`, [FAKE])
console.log('cleanup done')
console.log(ok ? 'LEDGER UNWRAP PASS' : 'LEDGER UNWRAP FAIL')
process.exit(ok ? 0 : 1)
