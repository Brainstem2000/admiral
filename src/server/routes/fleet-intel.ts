import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'

const fleetIntel = new Hono()

// GET /api/fleet-intel — return all aggregated fleet intelligence
fleetIntel.get('/', (c) => {
  try {
    const data = FleetIntelCollector.getAll()
    return c.json(data)
  } catch (e) {
    console.error('[fleet-intel] getAll failed:', e)
    return c.json({ market: [], systems: [], threats: [] })
  }
})

export default fleetIntel
