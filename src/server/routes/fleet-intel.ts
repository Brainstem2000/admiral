import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'

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

export default fleetIntel
