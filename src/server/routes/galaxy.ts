import { Hono } from 'hono'
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

export default galaxy
