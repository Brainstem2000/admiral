import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getTimelineEntries, getTokenAnalytics, listProfiles, addFinancialSnapshot, getFinancialSnapshots } from '../lib/db'
import { agentManager } from '../lib/agent-manager'

const analytics = new Hono()

/**
 * GET /api/analytics/timeline
 * Cross-agent interleaved log entries. Supports SSE streaming.
 * Query params: stream=true, afterId, limit, types (csv), profiles (csv)
 */
analytics.get('/timeline', async (c) => {
  const stream = c.req.query('stream') === 'true'
  const afterId = c.req.query('afterId') ? parseInt(c.req.query('afterId')!) : undefined
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : 200
  const types = c.req.query('types')?.split(',').filter(Boolean)
  const profileIds = c.req.query('profiles')?.split(',').filter(Boolean)

  if (!stream) {
    const entries = getTimelineEntries({ afterId, limit, types, profileIds })
    return c.json(entries)
  }

  // SSE stream: sends recent history, then live entries from all agents
  return streamSSE(c, async (sseStream) => {
    // Send recent history
    const recent = getTimelineEntries({ limit: 100, types, profileIds })
    for (const entry of recent) {
      await sseStream.writeSSE({ data: JSON.stringify(entry) })
    }

    let closed = false
    const handlers = new Map<string, (entry: unknown) => void>()

    const subscribe = () => {
      // Subscribe to all active agents
      const agents = agentManager.getAllAgents()
      for (const [id, agent] of agents) {
        if (profileIds && !profileIds.includes(id)) continue
        if (handlers.has(id)) continue
        const handler = (entry: unknown) => {
          if (closed) return
          const e = entry as { type?: string }
          if (types && e.type && !types.includes(e.type)) return
          sseStream.writeSSE({ data: JSON.stringify(entry) }).catch(() => { closed = true })
        }
        agent.events.on('log', handler)
        handlers.set(id, handler)
      }
    }

    subscribe()

    // Re-check for new agents periodically
    const interval = setInterval(() => {
      if (closed) { clearInterval(interval); return }
      subscribe()
    }, 3000)

    const heartbeat = setInterval(() => {
      if (closed) { clearInterval(heartbeat); return }
      sseStream.writeSSE({ data: '', comment: 'heartbeat' }).catch(() => { closed = true })
    }, 30000)

    const abortPromise = new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        clearInterval(heartbeat)
        for (const [id, handler] of handlers) {
          agentManager.getAgent(id)?.events.removeListener('log', handler)
        }
        resolve()
      })
    })

    await abortPromise
  })
})

/**
 * GET /api/analytics/tokens
 * Token usage and cost analytics aggregated from llm_call logs.
 * Query params: profileId, since (ISO date)
 */
analytics.get('/tokens', (c) => {
  const profileId = c.req.query('profileId') || undefined
  const since = c.req.query('since') || undefined
  const data = getTokenAnalytics({ profileId, since })
  return c.json(data)
})

/**
 * GET /api/analytics/financial
 * Financial summary per profile: wallet credits from live game state.
 * Note: As of SpaceMolt v0.222.0, credits live exclusively in the wallet —
 * per-station storage credits no longer exist.
 */
analytics.get('/financial', (c) => {
  const profiles = listProfiles()
  const result: {
    profiles: Array<{
      id: string
      name: string
      wallet: number
      total: number
      cargo: Array<{ item: string; quantity: number }>
    }>
    fleetTotal: number
    fleetCargo: Record<string, number>
  } = { profiles: [], fleetTotal: 0, fleetCargo: {} }

  for (const profile of profiles) {
    const agent = agentManager.getAgent(profile.id)
    const gameState = agent?.gameState as Record<string, unknown> | null | undefined
    const player = (gameState?.player ?? {}) as Record<string, unknown>
    const wallet = typeof player.credits === 'number' ? player.credits : 0

    // Extract cargo items from game state
    const cargo: Array<{ item: string; quantity: number }> = []
    const rawCargo = (gameState?.cargo ?? (gameState?.ship ? (gameState.ship as Record<string, unknown>)?.cargo : undefined)) as Array<Record<string, unknown>> | undefined
    if (Array.isArray(rawCargo)) {
      for (const c of rawCargo) {
        const item = String(c.item_id || c.name || '')
        const qty = Number(c.quantity ?? 1)
        if (item) {
          cargo.push({ item, quantity: qty })
          result.fleetCargo[item] = (result.fleetCargo[item] || 0) + qty
        }
      }
    }

    result.profiles.push({
      id: profile.id,
      name: profile.name,
      wallet,
      total: wallet,
      cargo,
    })
    result.fleetTotal += wallet
  }

  return c.json(result)
})

/**
 * GET /api/analytics/roi
 * Per-agent ROI: game credits earned vs API dollars spent.
 * Uses token cost data + current financial snapshot.
 */
analytics.get('/roi', (c) => {
  const profiles = listProfiles()
  const tokenData = getTokenAnalytics({})
  const result: {
    profiles: Array<{
      id: string
      name: string
      totalCredits: number
      apiCost: number
      creditsPerDollar: number
    }>
    fleetTotalCredits: number
    fleetApiCost: number
    fleetCreditsPerDollar: number
  } = { profiles: [], fleetTotalCredits: 0, fleetApiCost: 0, fleetCreditsPerDollar: 0 }

  for (const profile of profiles) {
    const agent = agentManager.getAgent(profile.id)
    const gameState = agent?.gameState as Record<string, unknown> | null | undefined
    const player = (gameState?.player ?? {}) as Record<string, unknown>
    const wallet = typeof player.credits === 'number' ? player.credits : 0
    const totalCredits = wallet

    const tokenStats = tokenData.byProfile[profile.id]
    const apiCost = tokenStats?.cost ?? 0

    result.profiles.push({
      id: profile.id,
      name: profile.name,
      totalCredits,
      apiCost,
      creditsPerDollar: apiCost > 0 ? Math.round(totalCredits / apiCost) : 0,
    })
    result.fleetTotalCredits += totalCredits
    result.fleetApiCost += apiCost
  }

  result.fleetCreditsPerDollar = result.fleetApiCost > 0
    ? Math.round(result.fleetTotalCredits / result.fleetApiCost)
    : 0

  return c.json(result)
})

/**
 * GET /api/analytics/snapshots
 * Historical financial snapshots for wealth-over-time charts.
 * Query params: profileId, since (ISO date)
 */
analytics.get('/snapshots', (c) => {
  const profileId = c.req.query('profileId') || undefined
  const since = c.req.query('since') || undefined
  const data = getFinancialSnapshots({ profileId, since })
  return c.json(data)
})

/**
 * Background snapshot timer: every 5 minutes, snapshot wallet for all connected agents.
 * As of SpaceMolt v0.222.0, credits live exclusively in the wallet.
 */
function takeFinancialSnapshots() {
  const profiles = listProfiles()
  let recorded = 0
  for (const profile of profiles) {
    const agent = agentManager.getAgent(profile.id)
    if (!agent?.isConnected) continue
    const gs = agent.gameState as Record<string, unknown> | null | undefined
    if (!gs) continue
    // Raw gameState from get_status has player.credits; slimGameState flattens to credits
    const player = gs.player as Record<string, unknown> | undefined
    const wallet = typeof player?.credits === 'number' ? player.credits
      : typeof gs.credits === 'number' ? gs.credits : 0
    if (wallet > 0) {
      addFinancialSnapshot(profile.id, wallet, 0)
      recorded++
    }
  }
}

// Start snapshotting every 5 minutes
setInterval(takeFinancialSnapshots, 5 * 60 * 1000)
// Take an initial snapshot after a short delay (let agents connect first)
setTimeout(takeFinancialSnapshots, 30_000)

export default analytics
