/**
 * Situational Briefing System
 *
 * Collects game state via direct connection queries (zero LLM tokens)
 * and builds compact text briefings injected into the agent's system prompt.
 *
 * Kill switch: preference "situational_briefing" = "off" disables injection.
 */
import type { GameConnection, CommandResult } from './connections/interface'

const REFRESH_INTERVAL = 60_000 // 60 seconds

interface CachedData {
  status: Record<string, unknown> | null
  cargo: unknown[] | null
  nearby: unknown[] | null
  market: unknown[] | null
  system: Record<string, unknown> | null
  missions: unknown[] | null
  updatedAt: number
}

const agentCaches = new Map<string, CachedData>()
const agentTimers = new Map<string, ReturnType<typeof setInterval>>()

function emptyCache(): CachedData {
  return { status: null, cargo: null, nearby: null, market: null, system: null, missions: null, updatedAt: 0 }
}

/** Execute a query command silently, returning parsed data or null */
async function safeQuery(conn: GameConnection, command: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const result: CommandResult = await conn.execute(command, args)
    if (result.error) return null
    return result.structuredContent ?? result.result ?? null
  } catch {
    return null
  }
}

/** Refresh all cached data for an agent via direct connection queries */
export async function refreshBriefingData(profileId: string, conn: GameConnection): Promise<void> {
  const cache = agentCaches.get(profileId) || emptyCache()

  // Run queries in parallel — these are all free query commands
  const [statusRaw, cargoRaw, nearbyRaw, systemRaw, missionsRaw] = await Promise.all([
    safeQuery(conn, 'get_status'),
    safeQuery(conn, 'get_cargo'),
    safeQuery(conn, 'get_nearby'),
    safeQuery(conn, 'get_system'),
    safeQuery(conn, 'get_active_missions'),
  ])

  if (statusRaw && typeof statusRaw === 'object') cache.status = statusRaw as Record<string, unknown>
  if (Array.isArray(cargoRaw)) cache.cargo = cargoRaw
  else if (cargoRaw && typeof cargoRaw === 'object' && 'cargo' in (cargoRaw as Record<string, unknown>)) {
    cache.cargo = (cargoRaw as Record<string, unknown>).cargo as unknown[]
  }
  if (Array.isArray(nearbyRaw)) cache.nearby = nearbyRaw
  else if (nearbyRaw && typeof nearbyRaw === 'object' && 'nearby' in (nearbyRaw as Record<string, unknown>)) {
    cache.nearby = (nearbyRaw as Record<string, unknown>).nearby as unknown[]
  }
  if (systemRaw && typeof systemRaw === 'object') cache.system = systemRaw as Record<string, unknown>
  if (Array.isArray(missionsRaw)) cache.missions = missionsRaw
  else if (missionsRaw && typeof missionsRaw === 'object' && 'missions' in (missionsRaw as Record<string, unknown>)) {
    cache.missions = (missionsRaw as Record<string, unknown>).missions as unknown[]
  }

  // Fetch market only if docked
  const player = cache.status?.player as Record<string, unknown> | undefined
  const isDocked = player?.docked === true || player?.is_docked === true
    || (cache.status as Record<string, unknown>)?.docked === true
  if (isDocked) {
    const marketRaw = await safeQuery(conn, 'view_market')
    if (marketRaw && typeof marketRaw === 'object') {
      const m = marketRaw as Record<string, unknown>
      cache.market = Array.isArray(m.items) ? m.items as unknown[]
        : Array.isArray(m.market) ? m.market as unknown[]
        : Array.isArray(marketRaw) ? marketRaw : null
    }
  } else {
    cache.market = null
  }

  cache.updatedAt = Date.now()
  agentCaches.set(profileId, cache)
}

/** Start periodic background refresh for an agent */
export function startBriefingCollector(profileId: string, conn: GameConnection): void {
  stopBriefingCollector(profileId) // clear any existing timer
  // Initial refresh after short delay (let login complete)
  setTimeout(() => refreshBriefingData(profileId, conn), 5_000)
  const timer = setInterval(() => refreshBriefingData(profileId, conn), REFRESH_INTERVAL)
  agentTimers.set(profileId, timer)
}

/** Stop periodic background refresh */
export function stopBriefingCollector(profileId: string): void {
  const timer = agentTimers.get(profileId)
  if (timer) {
    clearInterval(timer)
    agentTimers.delete(profileId)
  }
}

/** Clear cached data for an agent */
export function clearBriefingCache(profileId: string): void {
  agentCaches.delete(profileId)
  stopBriefingCollector(profileId)
}

/** Invalidate cached data without stopping the collector.
 *  Sets updatedAt to 0 so buildSituationalBriefing returns '' and
 *  cache intercept falls through to the live server.
 *  Called after action commands to ensure the next query gets fresh data. */
export function invalidateBriefingCache(profileId: string): void {
  const cache = agentCaches.get(profileId)
  if (cache) cache.updatedAt = 0
}

// ─── Briefing Builder ─────────────────────────────────────────────

function fmtNum(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K'
    : String(n)
}

/** Build a compact text briefing from cached data. Returns empty string if no data. */
export function buildSituationalBriefing(profileId: string): string {
  const cache = agentCaches.get(profileId)
  if (!cache || !cache.status || cache.updatedAt === 0) return ''

  const lines: string[] = []
  const gs = cache.status
  const player = gs.player as Record<string, unknown> | undefined
  const ship = gs.ship as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined

  // Location & basic stats
  const systemName = location?.system_name ?? player?.system ?? gs.system ?? '?'
  const poiName = location?.poi_name ?? player?.poi ?? gs.poi ?? ''
  const fuel = ship?.fuel ?? gs.fuel ?? '?'
  const maxFuel = ship?.max_fuel ?? ship?.fuel_capacity ?? '?'
  const hull = ship?.hull ?? gs.hull ?? '?'
  const maxHull = ship?.max_hull ?? ship?.hull_capacity ?? '?'
  const shield = ship?.shield ?? gs.shield
  const credits = player?.credits ?? gs.credits ?? 0
  const isDocked = player?.docked === true || player?.is_docked === true || gs.docked === true

  lines.push(`Location: ${systemName}${poiName ? ' > ' + poiName : ''} | ${isDocked ? 'Docked' : 'In space'}`)
  lines.push(`Wallet: ${fmtNum(Number(credits))}cr | Fuel: ${fuel}/${maxFuel} | Hull: ${hull}/${maxHull}${shield !== undefined ? ' | Shield: ' + shield : ''}`)

  // Ship info
  if (ship) {
    const shipClass = ship.class_id ?? ship.class ?? ship.name ?? ''
    const cargoUsed = ship.cargo_used ?? '?'
    const cargoMax = ship.cargo_capacity ?? ship.max_cargo ?? '?'
    lines.push(`Ship: ${shipClass} | Cargo: ${cargoUsed}/${cargoMax}`)
  }

  // Cargo contents
  if (cache.cargo && cache.cargo.length > 0) {
    const items = cache.cargo.map((c: unknown) => {
      const item = c as Record<string, unknown>
      const name = item.item_id ?? item.name ?? item.item ?? '?'
      const qty = item.quantity ?? 1
      return `${name} x${qty}`
    })
    lines.push(`Cargo: ${items.join(', ')}`)
  } else if (cache.cargo) {
    lines.push('Cargo: empty')
  }

  // Active missions
  if (cache.missions && cache.missions.length > 0) {
    const missionStrs = cache.missions.slice(0, 3).map((m: unknown) => {
      const mission = m as Record<string, unknown>
      const desc = mission.description ?? mission.title ?? mission.type ?? '?'
      const target = mission.target_poi ?? mission.destination ?? ''
      return `${desc}${target ? ' → ' + target : ''}`
    })
    lines.push(`Missions: ${missionStrs.join(' | ')}`)
  }

  // System POIs
  if (cache.system) {
    const pois = (cache.system.pois ?? cache.system.points_of_interest) as unknown[] | undefined
    if (Array.isArray(pois) && pois.length > 0) {
      const poiNames = pois.map((p: unknown) => {
        const poi = p as Record<string, unknown>
        return poi.name ?? poi.poi_name ?? '?'
      })
      lines.push(`System POIs: ${poiNames.join(', ')}`)
    }
  }

  // Nearby entities
  if (cache.nearby && cache.nearby.length > 0) {
    const players = cache.nearby.filter((n: unknown) => {
      const e = n as Record<string, unknown>
      return e.type === 'player' || e.type === 'ship'
    })
    const others = cache.nearby.length - players.length
    if (players.length > 0) {
      const names = players.slice(0, 5).map((p: unknown) => (p as Record<string, unknown>).name ?? '?')
      lines.push(`Nearby players: ${names.join(', ')}${players.length > 5 ? ` (+${players.length - 5} more)` : ''}`)
    }
    if (others > 0) {
      lines.push(`Nearby objects: ${others}`)
    }
  }

  // Market summary (top 5 items by margin if available)
  if (cache.market && cache.market.length > 0) {
    const items = cache.market.slice(0, 8).map((m: unknown) => {
      const item = m as Record<string, unknown>
      const name = item.item_id ?? item.name ?? '?'
      const buyPrice = item.buy_price ?? item.price ?? '?'
      const sellPrice = item.sell_price ?? ''
      return sellPrice ? `${name} (buy:${buyPrice} sell:${sellPrice})` : `${name} @${buyPrice}`
    })
    lines.push(`Market: ${items.join(', ')}`)
  }

  const age = Math.round((Date.now() - cache.updatedAt) / 1000)
  lines.push(`(Data age: ${age}s)`)

  return lines.join('\n')
}
