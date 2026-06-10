import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'

const fleetIntel = new Hono()

// GET /api/fleet-intel — all aggregated fleet intelligence.
// GET /api/fleet-intel?hunting=true[&threshold=N] — Hunting Grounds: low-police belt systems.
fleetIntel.get('/', (c) => {
  try {
    if (c.req.query('hunting') === 'true') {
      const t = Number(c.req.query('threshold')) || 20
      return c.json({
        hunting_grounds: FleetIntelCollector.getHuntingGrounds(t),
        kill_zones: FleetIntelCollector.getKillZones(),
      })
    }
    const data = FleetIntelCollector.getAll()
    return c.json(data)
  } catch (e) {
    console.error('[fleet-intel] failed:', e)
    return c.json({ market: [], systems: [], threats: [], hunting_grounds: [] })
  }
})

export default fleetIntel
