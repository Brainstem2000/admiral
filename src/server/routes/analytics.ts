import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getTimelineEntries, getTokenAnalytics, listProfiles, addFinancialSnapshot, getFinancialSnapshots, getLatestWallets, getProfileLastStates, realisableValue, getDb } from '../lib/db'
import { LedgerCollector } from '../lib/ledger'
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
      walletLive: boolean
      walletAt: string | null
      assets: number
      assetsDepthUnknown: number
      total: number
      cargo: Array<{ item: string; quantity: number }>
    }>
    fleetTotal: number
    fleetWallet: number
    fleetAssets: number
    fleetAssetsDepthUnknown: number
    fleetCargo: Record<string, number>
  } = {
    profiles: [], fleetTotal: 0, fleetWallet: 0, fleetAssets: 0,
    fleetAssetsDepthUnknown: 0, fleetCargo: {},
  }

  // Parked agents have no live gameState. Reading the wallet only off a
  // connected agent made fleet net worth collapse to whatever fraction of the
  // fleet happened to be online — the banked snapshot is the honest fallback.
  const banked = getLatestWallets()
  const lastStates = getProfileLastStates()
  const db = getDb()

  // Holdings per profile: everything in station storage plus the ship's hold.
  const holdingsFor = (profileId: string): Map<string, number> => {
    const held = new Map<string, number>()
    const add = (item: string, qty: number) => {
      if (!item || !Number.isFinite(qty) || qty <= 0) return
      held.set(item, (held.get(item) ?? 0) + qty)
    }
    for (const r of db.query('SELECT item_id, SUM(quantity) q FROM storage_inventory WHERE profile_id = ? GROUP BY item_id')
      .all(profileId) as Array<{ item_id: string; q: number }>) add(r.item_id, Number(r.q))
    for (const r of db.query('SELECT item_id, SUM(quantity) q FROM cargo_inventory WHERE profile_id = ? GROUP BY item_id')
      .all(profileId) as Array<{ item_id: string; q: number }>) add(r.item_id, Number(r.q))
    return held
  }

  for (const profile of profiles) {
    const agent = agentManager.getAgent(profile.id)
    const gameState = agent?.gameState as Record<string, unknown> | null | undefined
    const player = (gameState?.player ?? {}) as Record<string, unknown>

    const liveWallet = typeof player.credits === 'number' ? player.credits : null
    const snap = banked.get(profile.id)
    const lastState = lastStates.get(profile.id)
    const fallback = snap?.wallet ?? (typeof lastState?.credits === 'number' ? lastState.credits as number : 0)
    const wallet = liveWallet ?? fallback
    const walletAt = liveWallet != null ? null : (snap?.at ?? (lastState?.updated_at as string | undefined) ?? null)

    // Asset value uses min(held, bid depth) x best bid — never price x holdings.
    // A depth-less row is an unvalidated ceiling, so it is reported separately
    // rather than folded silently into a number that reads as bankable.
    let assets = 0
    let depthUnknown = 0
    for (const [itemId, qty] of holdingsFor(profile.id)) {
      const rv = realisableValue(itemId, qty)
      if (!rv.value) continue
      assets += rv.value
      if (!rv.depth_known) depthUnknown += rv.value
    }

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
      walletLive: liveWallet != null,
      walletAt,
      assets,
      assetsDepthUnknown: depthUnknown,
      total: wallet + assets,
      cargo,
    })
    result.fleetWallet += wallet
    result.fleetAssets += assets
    result.fleetAssetsDepthUnknown += depthUnknown
    result.fleetTotal += wallet + assets
  }

  result.profiles.sort((a, b) => b.total - a.total)
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
 * GET /api/analytics/ledger
 * Per-event credit ledger parsed from game command results.
 * Query params: profileId (required), since, kind, item_id, limit (cap 2000, default 500).
 */
analytics.get('/ledger', (c) => {
  const profileId = c.req.query('profileId')
  if (!profileId) return c.json({ error: 'profileId is required' }, 400)
  const since = c.req.query('since') || undefined
  const kind = c.req.query('kind') || undefined
  const itemId = c.req.query('item_id') || undefined
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : 500

  const rows = LedgerCollector.getEntries({ profileId, since, kind, itemId, limit })
  const summary = LedgerCollector.getSummary({ profileId, since, kind, itemId })
  return c.json({ rows, summary })
})

/**
 * GET /api/analytics/ledger/reconcile
 * Windows between consecutive financial_snapshots vs booked ledger movement.
 * Query params: profileId (required), since (default last 24h).
 */
analytics.get('/ledger/reconcile', (c) => {
  const profileId = c.req.query('profileId')
  if (!profileId) return c.json({ error: 'profileId is required' }, 400)
  const since = c.req.query('since') || undefined
  return c.json(LedgerCollector.reconcile(profileId, since))
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
