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
    // ?facilities=true[&type=substr][&recipe=id][&owned=true] — where things can be crafted.
    if (c.req.query('facilities') === 'true') {
      return c.json({
        facilities: FleetIntelCollector.getFacilities({
          type: c.req.query('type') || undefined,
          recipe: c.req.query('recipe') || undefined,
          ownedOnly: c.req.query('owned') === 'true',
        }),
      })
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

/**
 * POST /api/fleet-intel/facilities — register a facility the FLEET BUILT.
 *
 * Public facilities get captured passively from `facility_list` and from the `no_facility`
 * error hint, but one we paid to construct is an asset with upkeep and must be recorded
 * deliberately — otherwise it is invisible until somebody happens to dock there and look.
 *
 * body: { station_id, facility_type, facility_name?, station_name?, system_name?,
 *         recipe_id?, build_cost?, owner_profile_id?, notes?, reported_by? }
 */
fleetIntel.post('/facilities', async (c) => {
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b?.station_id || !b?.facility_type) {
    return c.json({ error: 'station_id and facility_type are required' }, 400)
  }
  try {
    FleetIntelCollector.recordOwnedFacility({
      stationId: String(b.station_id),
      facilityType: String(b.facility_type),
      facilityName: b.facility_name ? String(b.facility_name) : undefined,
      stationName: b.station_name ? String(b.station_name) : undefined,
      systemName: b.system_name ? String(b.system_name) : undefined,
      recipeId: b.recipe_id ? String(b.recipe_id) : undefined,
      buildCost: b.build_cost != null ? Number(b.build_cost) : undefined,
      ownerProfileId: b.owner_profile_id ? String(b.owner_profile_id) : undefined,
      notes: b.notes ? String(b.notes) : undefined,
      reportedBy: b.reported_by ? String(b.reported_by) : 'admiral',
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

export default fleetIntel
