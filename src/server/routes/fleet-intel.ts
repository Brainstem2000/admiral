import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'
import { findDeposits, getPoiDeposits, depositStats, realisableValue, getFleetItemTotals, listObligations } from '../lib/db'

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
    // ?obligations=true[&profile=id] — standing drains: facility rents + taxes,
    // folded from the action log. Exists because a rented Crew Bunk + Ledger Desk
    // billed one agent ~2M credits over 30 days with no surface anywhere.
    if (c.req.query('obligations') === 'true') {
      return c.json({ obligations: listObligations(c.req.query('profile') || undefined) })
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
 * GET /api/fleet-intel/realisable?item=<item_id>&held=<n>  — what n units would really fetch
 * GET /api/fleet-intel/realisable                          — same, for everything the fleet holds
 *
 * Answers "what is this actually worth" without multiplying price by holdings. The naive
 * product assumes a bid exists for every unit at the top price; capping each line at the
 * quantity actually bid for cut a 4,394,759 valuation of fleet stock to 1,565,224.
 *
 * Lines whose depth was never captured are reported separately and NOT added to the total,
 * because their figure is the uncapped one this endpoint exists to stop people quoting.
 */
fleetIntel.get('/realisable', (c) => {
  const item = c.req.query('item')
  if (item) {
    return c.json(realisableValue(item, Number(c.req.query('held') ?? 0)))
  }
  const lines = getFleetItemTotals().map(t => realisableValue(t.item_id, t.total))
  const priced = lines.filter(l => l.depth_known && l.value > 0)
  const unpriced = lines.filter(l => !l.depth_known && l.value > 0)
  const sum = (rows: typeof lines) => rows.reduce((n, l) => n + l.value, 0)
  return c.json({
    realisable_total: sum(priced),
    depth_unknown_ceiling: sum(unpriced),
    priced_lines: priced.length,
    depth_unknown_lines: unpriced.length,
    lines: [...priced, ...unpriced].sort((a, b) => b.value - a.value).slice(0, 200),
  })
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
