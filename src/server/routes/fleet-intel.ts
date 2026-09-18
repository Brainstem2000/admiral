import { Hono } from 'hono'
import { FleetIntelCollector } from '../lib/fleet-intel'
import { findDeposits, getPoiDeposits, depositStats, searchDepositItems, realisableValue, getFleetItemTotals, listObligations, listActiveObligations, getIntelDashboard } from '../lib/db'
import { routeWithSafety, systemFor, resolvePlace } from '../lib/places'

const fleetIntel = new Hono()

/** Where the fleet asks from unless told otherwise: the home system, Krynn. */
const HOME_SYSTEM = 'krynn'

// GET /api/fleet-intel/dashboard — central intelligence dashboard: coverage,
// freshness, cross-domain discovery feed, per-agent contribution leaderboard.
fleetIntel.get('/dashboard', (c) => {
  try {
    return c.json(getIntelDashboard())
  } catch (e) {
    console.error('[fleet-intel] dashboard failed:', e)
    return c.json({ coverage: {}, fresh: {}, feed: [], leaderboard: [] }, 500)
  }
})

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
    // ?obligations=true[&profile=id][&active=true] — standing drains: facility rents +
    // taxes, folded from the action log. Exists because a rented Crew Bunk + Ledger Desk
    // billed one agent ~2M credits over 30 days with no surface anywhere. The default is
    // the audit view (lapsed rows included); `active=true` is what the briefing shows.
    if (c.req.query('obligations') === 'true') {
      const profile = c.req.query('profile') || undefined
      const rows = c.req.query('active') === 'true' ? listActiveObligations(profile) : listObligations(profile)
      return c.json({ obligations: rows })
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
  const q = c.req.query('q')
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 200)

  // The picker: which ores have we ever actually seen in the ground.
  if (q != null && !item && !poi) return c.json({ q, items: searchDepositItems(q, 80) })

  if (item) {
    // "How far is that from me" is asked in whatever way is to hand — a system, a
    // station, or half a name. A station is not a node in the route graph, so it is
    // resolved and then converted to the system it sits in; an ambiguous fragment
    // comes back as a question rather than a silent guess at the wrong end of the map.
    let origin = HOME_SYSTEM
    let ambiguous: string[] = []
    const asked = (c.req.query('from') || '').trim()
    if (asked) {
      const r = resolvePlace(asked)
      if (r.exact) origin = systemFor(r.exact)
      else if (r.candidates.length) ambiguous = r.candidates
      else origin = asked.toLowerCase().replace(/\s+/g, '_')
    }
    if (ambiguous.length) return c.json({ item_id: item, from: asked, ambiguous })

    const rows = findDeposits(item, limit, c.req.query('empty') === '1')
    // A belt is only as useful as the trip to it, so every row carries the route
    // from where the asking is done. Graded per SYSTEM and memoised: a dozen
    // deposits routinely share three systems, and BFS over the whole known map
    // per row turned a lookup into a stall.
    const seen = new Map<string, ReturnType<typeof routeWithSafety>>()
    const deposits = rows.map(r => {
      const sys = String(r.system_id || '') || systemFor(String(r.poi_id || ''))
      let route = seen.get(sys)
      if (!route && sys) { route = routeWithSafety(origin, sys); seen.set(sys, route) }
      return {
        ...r,
        jumps: route?.found ? route.jumps : null,
        worst_hop: route?.worst?.risk ?? null,
        lawless_hops: route?.lawless_hops ?? null,
        crosses_killzone: route?.crosses_killzone ?? false,
      }
    })
    return c.json({ item_id: item, from: origin, deposits })
  }

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
