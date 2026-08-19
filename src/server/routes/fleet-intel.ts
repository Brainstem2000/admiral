import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'
import { findDeposits, getPoiDeposits, depositStats } from '../lib/db'

const fleetIntel = new Hono()

// GET /api/fleet-intel — all aggregated fleet intelligence.
// GET /api/fleet-intel?hunting=true[&threshold=N] — Hunting Grounds: low-police belt systems.
// GET /api/fleet-intel?sightings=true[&ship_class=substr] — player-sighting register (ship-class census).
fleetIntel.get('/', (c) => {
  try {
    if (c.req.query('hunting') === 'true') {
      const t = Number(c.req.query('threshold')) || 20
      return c.json({
        hunting_grounds: FleetIntelCollector.getHuntingGrounds(t),
        // Ghost rows are included (with ghost=1) so the UI can tag them; briefings exclude them.
        kill_zones: FleetIntelCollector.getKillZones(25, true),
      })
    }
    if (c.req.query('sightings') === 'true') {
      return c.json({
        sightings: FleetIntelCollector.getSightings(500, c.req.query('ship_class') || undefined),
      })
    }
    if (c.req.query('wrecks') === 'true') {
      return c.json({ wrecks: FleetIntelCollector.getWreckObservations() })
    }
    const data = FleetIntelCollector.getAll()
    return c.json(data)
  } catch (e) {
    console.error('[fleet-intel] failed:', e)
    return c.json({ market: [], systems: [], threats: [], hunting_grounds: [] })
  }
})


/**
 * GET /api/fleet-intel/deposits?item=<item_id>   — where the fleet has seen it, richest first
 * GET /api/fleet-intel/deposits?poi=<poi_id>     — everything known about one POI
 * GET /api/fleet-intel/deposits                  — coverage summary
 *
 * Answers "where is silver" from what the fleet already surveyed, instead of
 * sending someone to fly and find out again.
 */
fleetIntel.get('/deposits', (c) => {
  const item = c.req.query('item')
  const poi = c.req.query('poi')
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 200)
  if (item) return c.json({ item_id: item, deposits: findDeposits(item, limit) })
  if (poi) return c.json({ poi_id: poi, deposits: getPoiDeposits(poi) })
  return c.json(depositStats())
})

export default fleetIntel
