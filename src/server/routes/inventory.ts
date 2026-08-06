import { Hono } from 'hono'
import {
  getStorageForProfile,
  findItemAcrossFleet,
  getFleetItemTotals,
  getStorageShips,
  listProfiles,
} from '../lib/db'

/**
 * Fleet storage ledger — the machine-kept answer to "what do we own and where".
 *
 * Rows are written automatically from every view_storage response (see
 * recordStorageFromCommand in tools.ts), so this reflects what the game actually
 * reported rather than what an agent remembered writing down.
 */
const inventory = new Hono()

/** GET /api/inventory — fleet-wide totals per item, biggest first. */
inventory.get('/', (c) => {
  const totals = getFleetItemTotals()
  return c.json({ items: totals, count: totals.length })
})

/** GET /api/inventory/item/:itemId — who holds it and where. */
inventory.get('/item/:itemId', (c) => {
  const itemId = c.req.param('itemId')
  const rows = findItemAcrossFleet(itemId)
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  return c.json({
    item_id: itemId,
    total: rows.reduce((n, r) => n + r.quantity, 0),
    holdings: rows.map(r => ({
      profile_id: r.profile_id,
      agent: names.get(r.profile_id) ?? r.profile_id,
      station_id: r.station_id,
      quantity: r.quantity,
      updated_at: r.updated_at,
    })),
  })
})

/** GET /api/inventory/profile/:id[?station=] — one agent's full ledger. */
inventory.get('/profile/:id', (c) => {
  const id = c.req.param('id')
  const station = c.req.query('station') || undefined
  const rows = getStorageForProfile(id, station)
  const byStation: Record<string, Array<{ item_id: string; quantity: number; updated_at: string }>> = {}
  for (const r of rows) {
    ;(byStation[r.station_id] ??= []).push({ item_id: r.item_id, quantity: r.quantity, updated_at: r.updated_at })
  }
  return c.json({
    profile_id: id,
    station_count: Object.keys(byStation).length,
    total_units: rows.reduce((n, r) => n + r.quantity, 0),
    stations: byStation,
    ships: getStorageShips(id),
  })
})

/** GET /api/inventory/ships — every parked ship the fleet owns, fleet-wide. */
inventory.get('/ships', (c) => {
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  const ships = getStorageShips().map(s => ({ ...s, agent: names.get(String(s.profile_id)) ?? s.profile_id }))
  return c.json({ ships, count: ships.length })
})

/** GET /api/inventory/stale?hours=24 — ledgers nobody has refreshed lately. */
inventory.get('/stale', (c) => {
  const hours = Number(c.req.query('hours') ?? 24)
  const cutoff = Date.now() - hours * 3600_000
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  const stale: Array<{ agent: string; station_id: string; updated_at: string }> = []
  const seen = new Set<string>()
  for (const p of listProfiles()) {
    for (const r of getStorageForProfile(p.id)) {
      const key = `${r.profile_id}:${r.station_id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (new Date(r.updated_at + 'Z').getTime() < cutoff) {
        stale.push({ agent: names.get(r.profile_id) ?? r.profile_id, station_id: r.station_id, updated_at: r.updated_at })
      }
    }
  }
  return c.json({ cutoff_hours: hours, stale, count: stale.length })
})

export default inventory
