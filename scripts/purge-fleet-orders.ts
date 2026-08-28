/**
 * Admiral purge 2026-08-28: cancel ALL pending fleet orders. They accumulated
 * across superseded campaign phases (BoM sourcing, fuel rescues, credit
 * requests) and kept injecting dead objectives into agent briefings — Grit
 * deadlocked tonight against four of them. Directives are the single source of
 * standing orders now; peer-to-peer fleet orders start clean.
 *
 *   bun scripts/purge-fleet-orders.ts
 */
import { getDb, updateFleetOrder } from '../src/server/lib/db'

const db = getDb()
const rows = db.query(`SELECT id FROM fleet_orders WHERE status = 'pending'`).all() as Array<{ id: string }>
for (const r of rows) {
  updateFleetOrder(r.id, { status: 'cancelled', progress: 'Admiral purge 2026-08-28: stale campaign phase; directives are authoritative' })
}
console.log(`cancelled ${rows.length} stale fleet orders`)
console.log('remaining pending:', (db.query(`SELECT COUNT(*) c FROM fleet_orders WHERE status='pending'`).get() as any).c)
