import { Hono } from 'hono'
import {
  getBestKnownBids,
  getStorageForProfile,
  getCargoForProfile,
  findItemAcrossFleet,
  getFleetItemTotals,
  getStorageShips,
  listProfiles,
  getItemHistory,
  getStorageDirty,
} from '../lib/db'

/**
 * Fleet inventory ledger — the machine-kept answer to "what do we own, where,
 * and who can actually use it".
 *
 * Rows are written automatically from every storage and cargo response (see
 * recordStorageFromCommand / recordCargoFromCommand in tools.ts), so this
 * reflects what the game actually reported rather than what an agent remembered
 * writing down. Both are FREE queries agents run constantly, so the ledger stays
 * warm at zero tick cost.
 *
 * Read `usable`, not `total`. Crafting and supply_commission pull only from ONE
 * agent's storage at ONE station, so a fleet-wide total is a fiction as far as
 * getting work done is concerned — 2,937 platinum ore across the fleet was 31
 * usable by the crafter who needed it, and the build stalled on exactly that gap.
 */
const inventory = new Hono()

/** GET /api/inventory — fleet-wide totals per item, biggest first. */
inventory.get('/', (c) => {
  const totals = getFleetItemTotals()
  return c.json({ items: totals, count: totals.length })
})

/**
 * GET /api/inventory/item/:itemId — who holds it and where.
 *
 * `usable` is the number that actually matters and the one this API used to hide:
 * crafting and supply_commission pull only from ONE agent's storage at ONE station,
 * so a fleet total of 2,981 platinum can mean 31 usable. Pass ?by=<profileId>
 * &at=<stationId> to get the actionable figure for a specific crafter.
 */
inventory.get('/item/:itemId', (c) => {
  const itemId = c.req.param('itemId')
  const by = c.req.query('by') || undefined
  const at = c.req.query('at') || undefined
  const rows = findItemAcrossFleet(itemId)
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  const holdings = rows.map(r => ({
    profile_id: r.profile_id,
    agent: names.get(r.profile_id) ?? r.profile_id,
    station_id: r.station_id,
    in_cargo: r.station_id === '(cargo)',
    quantity: r.quantity,
    updated_at: r.updated_at,
  }))
  // Biggest single (agent, station) pile — the largest amount any one actor can
  // craft with today, without anybody flying anywhere.
  const piles = new Map<string, number>()
  for (const h of holdings) piles.set(`${h.profile_id}|${h.station_id}`, (piles.get(`${h.profile_id}|${h.station_id}`) ?? 0) + h.quantity)
  const [bestKey, bestQty] = [...piles.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  return c.json({
    item_id: itemId,
    total: holdings.reduce((n, r) => n + r.quantity, 0),
    in_cargo: holdings.filter(h => h.in_cargo).reduce((n, r) => n + r.quantity, 0),
    usable: by
      ? holdings.filter(h => h.profile_id === by && (!at || h.station_id === at))
          .reduce((n, r) => n + r.quantity, 0)
      : bestQty,
    usable_by: by ? (names.get(by) ?? by) : (names.get(bestKey.split('|')[0]) ?? null),
    usable_at: by ? (at ?? null) : (bestKey.split('|')[1] || null),
    holdings,
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
  const cargo = getCargoForProfile(id).map(r => ({ item_id: r.item_id, quantity: r.quantity, updated_at: r.updated_at }))
  const itemIds = [...new Set([...rows.map(r => r.item_id), ...cargo.map(r => r.item_id)])]
  return c.json({
    profile_id: id,
    station_count: Object.keys(byStation).length,
    total_units: rows.reduce((n, r) => n + r.quantity, 0),
    stations: byStation,
    cargo,
    ships: getStorageShips(id),
    // Last known value per item from the fleet's own market observations:
    // { item_id: { price, qty, station, observed_at } }
    bids: getBestKnownBids(itemIds),
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

/**
 * GET /api/inventory/history/:itemId — every recorded movement of one item.
 *
 * Sourced from the game's own action log, so it answers "where did it all go"
 * with events rather than inference.
 */
inventory.get('/history/:itemId', (c) => {
  const itemId = c.req.param('itemId')
  const limit = Math.min(Number(c.req.query('limit') ?? 60), 500)
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  const rows = getItemHistory(itemId, limit).map(r => ({
    agent: names.get(String(r.profile_id)) ?? r.profile_id,
    at: r.created_at,
    event: r.event_type,
    data: JSON.parse(String(r.data ?? '{}')),
  }))
  return c.json({ item_id: itemId, count: rows.length, events: rows })
})

/**
 * GET /api/inventory/dirty — agents whose storage moved somewhere we cannot place.
 *
 * deposit/withdraw/gift events carry no station id, so rather than guess we flag
 * the agent and wait for a view_storage to settle it. These are the ledgers you
 * should distrust right now.
 */
inventory.get('/dirty', (c) => {
  const names = new Map(listProfiles().map(p => [p.id, p.name]))
  const rows = getStorageDirty().map(r => ({
    agent: names.get(r.profile_id) ?? r.profile_id,
    reason: r.reason,
    since: r.since,
  }))
  return c.json({ dirty: rows, count: rows.length })
})

export default inventory
