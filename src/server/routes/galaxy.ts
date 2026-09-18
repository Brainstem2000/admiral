import { Hono } from 'hono'
import { describePlace, routeWithSafety, resolvePlace } from '../lib/places'
import { getGalaxyMap, setGalaxyMap } from '../lib/db'
import { agentManager } from '../lib/agent-manager'
import type { GalaxyMapData, GalaxySystem } from '../../shared/galaxy-types'

const galaxy = new Hono()

// GET /api/galaxy — return cached galaxy map
galaxy.get('/', (c) => {
  const data = getGalaxyMap()
  if (!data) return c.json({ error: 'No galaxy data cached. POST /api/galaxy/refresh to fetch.' }, 404)
  return c.json(data)
})

// POST /api/galaxy/refresh — fetch via a connected agent and cache
galaxy.post('/refresh', async (c) => {
  const activeIds = agentManager.listActive()
  if (activeIds.length === 0) {
    return c.json({ error: 'No connected agents. Connect at least one agent first.' }, 400)
  }

  // Use first connected agent
  const profileId = activeIds[0]
  const agent = agentManager.getAgent(profileId)
  if (!agent || !agent.isConnected) {
    return c.json({ error: 'Agent not connected' }, 400)
  }

  try {
    const result = await agent.executeCommand('get_map', {})
    const raw = (result as Record<string, unknown>).result ?? result
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { systems: GalaxySystem[]; total_count: number }

    if (!parsed.systems || !Array.isArray(parsed.systems)) {
      return c.json({ error: 'Invalid map data from game' }, 502)
    }

    const data: GalaxyMapData = {
      systems: parsed.systems,
      total_count: parsed.total_count || parsed.systems.length,
      fetched_at: new Date().toISOString(),
      fetched_by: profileId,
    }

    setGalaxyMap(data)
    return c.json(data)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * GET /api/galaxy/place/:id — everything known about one place, system or station.
 * GET /api/galaxy/route?from=&to= — a path WITH the risk of every hop.
 *
 * The game's own find_route returns a path and says nothing about its safety, and
 * grading a corridor by its DESTINATION is how 228 weapon_core were sent down a
 * 13-hop zero-police run. A corridor is exactly as safe as its worst jump, so the
 * worst intermediate hop is reported rather than averaged away, and a route that
 * crosses a hard-banned killzone also returns a killzone-free detour when one exists.
 */
galaxy.get('/place/:id', (c) => {
  const raw = c.req.param('id')
  const r = resolvePlace(raw)
  if (!r.exact && r.candidates.length) return c.json({ query: raw, found: false, candidates: r.candidates })
  return c.json(describePlace(r.exact ?? raw))
})

/**
 * Both lookups used to take the text as an EXACT id and answer `found: false` on a miss.
 * "iron" from krynn returned nothing at all, while iron_reach, ironhearth, ironhollow,
 * ironpeak and ironveil were all sitting in the graph — which reads as "there is no route
 * from here", a far more alarming claim than "say which one you meant". Now an ambiguous
 * query comes back with the candidates so the UI can offer them, and a query matching
 * exactly one place is simply resolved.
 */
galaxy.get('/route', (c) => {
  const from = c.req.query('from'), to = c.req.query('to')
  if (!from || !to) return c.json({ error: 'from and to are required' }, 400)
  const f = resolvePlace(from), t = resolvePlace(to)
  if (!f.exact && f.candidates.length) return c.json({ from, to, found: false, ambiguous: 'from', candidates: f.candidates })
  if (!t.exact && t.candidates.length) return c.json({ from, to, found: false, ambiguous: 'to', candidates: t.candidates })
  return c.json({ ...routeWithSafety(f.exact ?? from, t.exact ?? to), resolved_from: f.exact ?? from, resolved_to: t.exact ?? to })
})

export default galaxy
