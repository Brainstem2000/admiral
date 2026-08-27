/**
 * Periodic galaxy-map refresh. The Map page renders a cached get_map snapshot
 * that previously only updated on a manual POST — an explorer could map a dozen
 * systems (Zibal, 2026-08-27) with the UI none the wiser. Every interval we
 * re-fetch through the best-informed connected agent: get_map returns the
 * calling PLAYER's known universe, so the explorer's view is the one worth
 * caching; any agent is better than a stale snapshot.
 */

import { agentManager } from './agent-manager'
import { getProfile, setGalaxyMap } from './db'
import type { GalaxyMapData, GalaxySystem } from '../../shared/galaxy-types'

const REFRESH_INTERVAL_MS = 10 * 60 * 1000
let timer: ReturnType<typeof setInterval> | null = null

/** Fetch get_map through a connected agent (explorer preferred) and cache it. */
export async function refreshGalaxyMap(preferProfileId?: string): Promise<GalaxyMapData | null> {
  const activeIds = agentManager.listActive()
  if (activeIds.length === 0) return null

  // Preference order: explicit request → an agent on a DEEP EXPLORATION
  // directive (their map knowledge is the frontier) → first connected.
  const ordered = [
    ...(preferProfileId ? [preferProfileId] : []),
    ...activeIds.filter((id) => (getProfile(id)?.directive ?? '').includes('DEEP EXPLORATION')),
    ...activeIds,
  ]
  for (const id of ordered) {
    const agent = agentManager.getAgent(id)
    if (!agent || !agent.isConnected) continue
    try {
      const result = await agent.executeCommand('get_map', {}, { silent: true })
      const raw = (result as Record<string, unknown>).result ?? result
      const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { systems: GalaxySystem[]; total_count: number }
      if (!parsed.systems || !Array.isArray(parsed.systems)) continue
      const data: GalaxyMapData = {
        systems: parsed.systems,
        total_count: parsed.total_count || parsed.systems.length,
        fetched_at: new Date().toISOString(),
        fetched_by: getProfile(id)?.name ?? id,
      }
      setGalaxyMap(data)
      return data
    } catch {
      continue // next candidate
    }
  }
  return null
}

export function startGalaxyMapRefresher(): void {
  if (timer) return
  timer = setInterval(() => { void refreshGalaxyMap() }, REFRESH_INTERVAL_MS)
  console.log('[Galaxy] map refresher started (10-min interval, explorer-preferred)')
}
