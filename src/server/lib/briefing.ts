/**
 * Situational Briefing System
 *
 * Collects game state via direct connection queries (zero LLM tokens)
 * and builds compact text briefings injected into the agent's system prompt.
 *
 * Kill switch: preference "situational_briefing" = "off" disables injection.
 */
import type { GameConnection, CommandResult } from './connections/interface'
import type { Profile } from '../../shared/types'
import * as dbModule from './db'
import { listObligations, getProfile, listPlaybook, getStorageSummaryForProfile, getNavIntel, getHuntIntel, getDb, getKnownLinks, getGalaxyMap } from './db'
import type { ObligationRow } from './db'
import { galaxyMarketLines, directiveMarketLines } from './galaxy-market'

const REFRESH_INTERVAL = 60_000 // 60 seconds

// Agent role: ONE resolver (role.ts) so prompt.md, the command list and the
// briefing can never disagree about who is a hunter. Re-exported for callers
// that learned the name here.
import { resolveAgentRole, type AgentRole } from './role'
export { resolveAgentRole, type AgentRole }

interface CachedData {
  status: Record<string, unknown> | null
  cargo: unknown[] | null
  nearby: unknown[] | null
  /** Shootable things at this POI, flattened from get_nearby (see collectTargets). */
  targets: NearbyTarget[]
  market: unknown[] | null
  system: Record<string, unknown> | null
  missions: unknown[] | null
  /** Live freight contracts from `shipping(action="active")` — see renderFreight. */
  freight: unknown[] | null
  updatedAt: number
}

/**
 * Seconds per game tick, measured live 2026-09-02 (two `shipping` reads 20s
 * apart advanced the tick counter by 2). Only used to turn a tick countdown
 * into wall-clock for the briefing, so drift here is cosmetic — the tick
 * numbers themselves are always printed alongside.
 */
const TICK_SECONDS = 10

const agentCaches = new Map<string, CachedData>()
const agentTimers = new Map<string, ReturnType<typeof setInterval>>()
// Monotonic per-agent epoch, bumped on every invalidation (e.g. after a move). A refresh that
// began before a bump is discarded at write time, so an out-of-order async refresh can never
// overwrite newer state with a stale snapshot — the root cause of "system thinks I'm in <old system>".
const agentEpochs = new Map<string, number>()

function emptyCache(): CachedData {
  return { status: null, cargo: null, nearby: null, targets: [], market: null, system: null, missions: null, freight: null, updatedAt: 0 }
}

/**
 * Normalise get_system into one object shape.
 *
 * The command answers as JSON on some connections and as a plain text report on
 * others:
 *
 *   System: Krynn (krynn) | Empire: crimson | Security: Maximum Security
 *   POIs (7):
 *   id\tname\ttype\tclass\tbase\tonline
 *   war_citadel\tWar Citadel\tstation\t\tCrimson War Citadel\t28
 *   Connections (4):
 *   system_id\tname\tdistance
 *   iron_reach\tIron Reach\t399 GU
 *
 * The briefing used to keep the payload only when it was already an object, so
 * for text-answering agents the POI list AND the jump-link table were thrown
 * away without a word. Morg'Thar (2026-09-02) then guessed his way around the
 * map — jump(nashira) from gsc_0051, jump(scheat), jump(segin) — collecting
 * `not_connected` until the loop-breaker fired, because nothing in his prompt
 * ever told him which systems his current one actually touches.
 */
export function normalizeSystem(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null

  const text = raw
  // An in-transit reply is a status sentence, not a system report. Returning
  // null keeps the last real system cached rather than blanking it mid-jump.
  if (/^\s*IN TRANSIT/i.test(text)) return null

  const out: Record<string, unknown> = {}
  const head = text.match(/^System:\s*(.+?)\s*\(([^)]+)\)/m)
  if (head) { out.name = head[1]; out.id = head[2] }
  const emp = text.match(/Empire:\s*([^|\n]+)/)
  if (emp) out.empire = emp[1].trim()
  const sec = text.match(/Security:\s*([^|\n]+)/)
  if (sec) out.security = sec[1].trim()

  // Both tables are "Header (n):" then a \t header row then \t data rows.
  const section = (label: string): Record<string, string>[] => {
    const start = text.search(new RegExp(`^${label}\\s*\\(\\d+\\)\\s*:`, 'm'))
    if (start < 0) return []
    const lines = text.slice(start).split('\n').slice(1)
    const cols = (lines.shift() ?? '').split('\t').map((c) => c.trim())
    if (cols.length < 2) return []
    const rows: Record<string, string>[] = []
    for (const line of lines) {
      if (!line.includes('\t')) break            // next section, or end of report
      const cells = line.split('\t')
      const row: Record<string, string> = {}
      cols.forEach((c, i) => { row[c] = (cells[i] ?? '').trim() })
      if (Object.values(row).some((v) => v !== '')) rows.push(row)
    }
    return rows
  }

  const pois = section('POIs')
  if (pois.length > 0) out.pois = pois
  const conns = section('Connections')
  if (conns.length > 0) out.connections = conns
  return Object.keys(out).length > 0 ? out : null
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

/** One shootable thing at the agent's POI, flattened from get_nearby. */
export interface NearbyTarget {
  id: string
  name: string
  species: string
  kind: 'creature' | 'pirate' | 'npc'
  hull: number | null
  maxHull: number | null
  inCombat: boolean
}

/**
 * Flatten get_nearby into a list of things that can be attacked.
 *
 * The payload is `{creatures: [...], pirates: [...], empire_npcs: [...],
 * nearby: []}` — and `nearby` is empty even when the others are full, so any
 * reader that trusts `nearby` alone sees an empty system.
 */
export function collectTargets(raw: unknown): NearbyTarget[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const d = raw as Record<string, unknown>
  const out: NearbyTarget[] = []
  const groups: Array<[string, NearbyTarget['kind']]> = [
    ['creatures', 'creature'], ['pirates', 'pirate'], ['empire_npcs', 'npc'],
  ]
  for (const [key, kind] of groups) {
    const list = d[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const id = String(e.creature_id ?? e.npc_id ?? e.pirate_id ?? e.ship_id ?? e.id ?? '').trim()
      if (!id) continue
      const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null }
      out.push({
        id,
        name: String(e.name ?? e.species ?? kind),
        species: String(e.species ?? e.type ?? ''),
        kind,
        hull: num(e.hull),
        maxHull: num(e.max_hull),
        inCombat: e.in_combat === true,
      })
    }
  }
  return out
}

/** Refresh all cached data for an agent via direct connection queries */
export async function refreshBriefingData(profileId: string, conn: GameConnection): Promise<void> {
  const startEpoch = agentEpochs.get(profileId) ?? 0
  const cache = agentCaches.get(profileId) || emptyCache()

  // Fast path: a connection-maintained local state cache (lib_v2) covers
  // status/cargo/missions with zero round-trips — only nearby/system/market
  // still need the wire.
  const localState = conn.getLocalState?.() ?? null

  let statusRaw: unknown, cargoRaw: unknown, nearbyRaw: unknown, systemRaw: unknown, missionsRaw: unknown

  let shipRaw: unknown = null
  let freightRaw: unknown = null
  if (localState) {
    statusRaw = localState
    cargoRaw = localState.cargo ?? null
    // lib state's missions section is {active: [...]} — unwrap to the array the parser expects
    const ms = localState.missions as Record<string, unknown> | unknown[] | null | undefined
    missionsRaw = Array.isArray(ms) ? ms : (ms && typeof ms === 'object' && Array.isArray((ms as Record<string, unknown>).active)) ? (ms as Record<string, unknown>).active : null
    ;[nearbyRaw, systemRaw, shipRaw, freightRaw] = await Promise.all([
      safeQuery(conn, 'get_nearby'),
      safeQuery(conn, 'get_system'),
      // get_status carries no `modules` array, so the weapon loadout has to
      // come from get_ship. Free query, no game tick.
      safeQuery(conn, 'get_ship'),
      safeQuery(conn, 'shipping', { action: 'active' }),
    ])
  } else {
    // Run queries in parallel — these are all free query commands
    ;[statusRaw, cargoRaw, nearbyRaw, systemRaw, missionsRaw, shipRaw, freightRaw] = await Promise.all([
      safeQuery(conn, 'get_status'),
      safeQuery(conn, 'get_cargo'),
      safeQuery(conn, 'get_nearby'),
      safeQuery(conn, 'get_system'),
      safeQuery(conn, 'get_active_missions'),
      safeQuery(conn, 'get_ship'),
      safeQuery(conn, 'shipping', { action: 'active' }),
    ])
  }

  // Freight contracts run on their OWN clock, independent of missions, and a
  // lapsed one bills you. `shipping(action="active")` is a read and works
  // undocked, so there is no reason for an agent to ever be surprised by one.
  cache.freight = Array.isArray(freightRaw) ? freightRaw
    : (freightRaw && typeof freightRaw === 'object' && Array.isArray((freightRaw as Record<string, unknown>).shipments))
      ? (freightRaw as Record<string, unknown>).shipments as unknown[]
      : null

  if (statusRaw && typeof statusRaw === 'object') cache.status = statusRaw as Record<string, unknown>
  // Graft the module list from get_ship onto the cached ship object — the
  // renderer reads ship.modules, and get_status never provides it.
  if (shipRaw && typeof shipRaw === 'object' && cache.status) {
    const sr = shipRaw as Record<string, unknown>
    const mods = sr.modules ?? (sr.ship as Record<string, unknown> | undefined)?.modules
    if (Array.isArray(mods)) {
      const shipObj = (cache.status.ship as Record<string, unknown> | undefined) ?? {}
      cache.status.ship = { ...shipObj, modules: mods }
    }
  }
  if (Array.isArray(cargoRaw)) cache.cargo = cargoRaw
  else if (cargoRaw && typeof cargoRaw === 'object' && 'cargo' in (cargoRaw as Record<string, unknown>)) {
    cache.cargo = (cargoRaw as Record<string, unknown>).cargo as unknown[]
  }
  if (Array.isArray(nearbyRaw)) cache.nearby = nearbyRaw
  else if (nearbyRaw && typeof nearbyRaw === 'object' && 'nearby' in (nearbyRaw as Record<string, unknown>)) {
    cache.nearby = (nearbyRaw as Record<string, unknown>).nearby as unknown[]
  }
  // get_nearby's `nearby` array is EMPTY even when the POI is full of things to
  // shoot — the shootable entries live in `creatures` / `pirates` /
  // `empire_npcs`, each with its own id field. Reading only `nearby` meant the
  // briefing rendered "Nearby objects: 0" while four grazers sat in front of
  // Morg'Thar at Alkaid on 2026-09-02, and he jumped away without firing.
  cache.targets = collectTargets(nearbyRaw)
  // get_system answers as an OBJECT on some connections and as a plain TEXT
  // table on others. The object-only check that used to live here dropped the
  // whole payload — POIs and jump links included — for every text-answering
  // agent, silently. See normalizeSystem.
  const sys = normalizeSystem(systemRaw)
  if (sys) cache.system = sys
  if (Array.isArray(missionsRaw)) cache.missions = missionsRaw
  else if (missionsRaw && typeof missionsRaw === 'object' && 'missions' in (missionsRaw as Record<string, unknown>)) {
    cache.missions = (missionsRaw as Record<string, unknown>).missions as unknown[]
  }

  // Fetch market only if docked (handles both get_status shapes — see isAgentDocked)
  const isDocked = isAgentDocked(cache.status)
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

  // Discard if a newer invalidation happened while we were fetching — prevents an out-of-order
  // async refresh from overwriting fresh state with a stale snapshot (e.g. an old location).
  if ((agentEpochs.get(profileId) ?? 0) !== startEpoch) return
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
 *  Called after action commands to ensure the next query gets fresh data.
 *  Optionally pass connection to trigger an immediate background refresh. */
export function invalidateBriefingCache(profileId: string, conn?: GameConnection): void {
  const cache = agentCaches.get(profileId)
  if (cache) cache.updatedAt = 0
  // Bump the epoch so any refresh already in flight (e.g. from a prior jump) is discarded
  // instead of writing a stale location over the new one.
  agentEpochs.set(profileId, (agentEpochs.get(profileId) ?? 0) + 1)
  // Trigger immediate background refresh so next briefing has fresh data
  if (conn) {
    refreshBriefingData(profileId, conn).catch(() => {})
  }
}

/**
 * Make sure the cache holds SOMETHING before the first turn is assembled.
 *
 * The collector's first refresh runs 5s after connect, and connect_llm usually
 * follows connect within that window — so turn 1 of every session (and of
 * every context flush) rendered with an empty briefing, and under the
 * volatile split the agent booted with no memory, TODO or situation at all.
 * Bounded by `timeoutMs` so a slow game server delays the first turn by at
 * most that; a miss just means turn 1 runs the way it used to.
 */
export async function ensureBriefingWarm(profileId: string, conn: GameConnection, timeoutMs = 12_000): Promise<boolean> {
  const warm = () => {
    const c = agentCaches.get(profileId)
    return !!(c && c.status && c.updatedAt > 0)
  }
  if (warm()) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    refreshBriefingData(profileId, conn).catch(() => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)
  return warm()
}

// ─── Lookups the briefing renders with ───────────────────────────

/** Station ids in storage rows are frequently 32-hex opaque ids; the fleet's
 *  market and facility captures carry the display name for most of them. */
const stationNameCache = new Map<string, string>()
function stationDisplayName(stationId: string): string {
  const cached = stationNameCache.get(stationId)
  if (cached !== undefined) return cached
  let out = stationId
  try {
    const d = getDb()
    const m = d.query(`SELECT station_name FROM fleet_intel_market WHERE station_id = ? AND station_name <> '' LIMIT 1`)
      .get(stationId) as { station_name?: string } | null
    const f = d.query(`SELECT station_name, system_name FROM fleet_intel_facilities WHERE station_id = ? AND station_name <> '' LIMIT 1`)
      .get(stationId) as { station_name?: string; system_name?: string | null } | null
    const name = m?.station_name || f?.station_name || ''
    if (name) out = f?.system_name ? `${name} @${f.system_name}` : name
  } catch { /* a missing name is not worth breaking the briefing over */ }
  stationNameCache.set(stationId, out)
  return out
}

/** Hop counts over the fleet's learned jump graph, from one system outward.
 *  Bounded breadth-first walk; the adjacency is rebuilt at most once a minute
 *  because this runs on every turn's cache-comparison render. */
let linkAdjacency: { at: number; adj: Map<string, string[]> } | null = null
export function hopsFrom(origin: string, maxDepth = 4): Map<string, number> {
  const now = Date.now()
  if (!linkAdjacency || now - linkAdjacency.at > 60_000) {
    const adj = new Map<string, string[]>()
    const link = (a: string, b: string) => {
      if (!a || !b) return
      if (!adj.has(a)) adj.set(a, [])
      if (!adj.has(b)) adj.set(b, [])
      adj.get(a)!.push(b)
      adj.get(b)!.push(a)
    }
    try {
      for (const { a, b } of getKnownLinks()) link(a, b)
    } catch { /* no learned graph */ }
    // The learned graph only holds edges the fleet has flown; the galaxy_map
    // seed charts every system's connections (505 systems). Without the union,
    // hop counts existed for one system in six (Cloverfield showed as 6 jumps
    // from Frontier via flown edges; the map makes it 1 from Zosma).
    try {
      for (const s of getGalaxyMap()?.systems ?? []) {
        for (const c of (s as { connections?: string[] }).connections ?? []) link(String(s.system_id), String(c))
      }
    } catch { /* no seed map, learned edges only */ }
    linkAdjacency = { at: now, adj }
  }
  const dist = new Map<string, number>([[origin, 0]])
  let frontier = [origin]
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = []
    for (const s of frontier) {
      for (const n of linkAdjacency.adj.get(s) ?? []) {
        if (!dist.has(n)) { dist.set(n, depth); next.push(n) }
      }
    }
    frontier = next
  }
  return dist
}

function fmtHops(h: number | undefined): string {
  if (h === undefined) return 'route unknown'
  if (h === 0) return 'HERE'
  return `${h} jump${h > 1 ? 's' : ''}`
}

/** Per-empire reputation as the game reports it on the player: the v2 state
 *  carries `standings[empire].reputation`; the older shape is a flat
 *  `reputation[empire]` map. Negative means the empire's stations refuse you. */
function readReputation(gs: Record<string, unknown> | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  const player = gs?.player as Record<string, unknown> | undefined
  if (!player) return out
  const standings = player.standings as Record<string, { reputation?: unknown }> | undefined
  if (standings && typeof standings === 'object') {
    for (const [emp, s] of Object.entries(standings)) {
      const r = Number(s?.reputation)
      if (Number.isFinite(r)) out.set(emp, r)
    }
  }
  const flat = player.reputation as Record<string, unknown> | undefined
  if (flat && typeof flat === 'object') {
    for (const [emp, v] of Object.entries(flat)) {
      const r = Number(v)
      if (Number.isFinite(r) && !out.has(emp)) out.set(emp, r)
    }
  }
  return out
}

/** Day-granular age of a fleet_intel_systems row. Coarse ON PURPOSE: this text
 *  sits inside the cached prompt for non-split agents, so it may change at most
 *  once a day per line. */
function fmtRecordAge(updatedAt: string | null | undefined): string | null {
  if (!updatedAt) return null
  const t = Date.parse(String(updatedAt).replace(' ', 'T') + (String(updatedAt).endsWith('Z') ? '' : 'Z'))
  if (!Number.isFinite(t)) return null
  const days = Math.floor((Date.now() - t) / 86_400_000)
  return days < 1 ? 'seen today' : `${days}d old`
}

/** Auto-attached zero-credit distress/rescue entries are not contracts the
 *  agent chose; listing them buries the paid ones. */
function isAutoAttachedMission(m: Record<string, unknown>): boolean {
  if (String(m.type ?? '') === 'distress_response') return true
  return /^\s*distress:/i.test(String(m.title ?? m.name ?? ''))
}

/** Ticks are ~10s. Quantized to hours under two days, days beyond, so the
 *  line does not churn the cached prompt every tick. */
function fmtExpiry(m: Record<string, unknown>): string {
  const ticks = Number(m.expires_in_ticks)
  if (Number.isFinite(ticks) && ticks > 0) {
    const hours = (ticks * 10) / 3600
    if (hours < 1) return '<1h'
    if (hours < 48) return `~${Math.ceil(hours)}h`
    return `~${Math.round(hours / 24)}d`
  }
  const at = m.expires_at
  if (typeof at === 'string' && at) return at.slice(0, 16)
  return '?'
}

/** Rent rows go silent when the facility is gone (dismantle events are not
 *  always captured) and when the agent is simply away. Past this many hours of
 *  silence the row is treated as lapsed and NOT rendered — a 26-day-stale
 *  "ACTIVE RENTAL" nag sent one hunter on 88 facility queries in a day. */
const RENT_LAPSE_HOURS = 72

/** Whether an obligation row is lapsed. Defers to the db layer's own helper
 *  when it exists (the intel side owns the lapse rule), and always treats a
 *  non-active status or a long-silent row as lapsed regardless. */
function isObligationLapsed(o: ObligationRow, now: number): boolean {
  const helper = (dbModule as unknown as { isObligationLapsed?: (row: ObligationRow) => boolean }).isObligationLapsed
  if (typeof helper === 'function') {
    try { if (helper(o)) return true } catch { /* fall through to the local rule */ }
  }
  if (o.status !== 'active') return true
  const staleH = (now - Date.parse(o.last_seen)) / 3_600_000
  return Number.isFinite(staleH) && staleH > RENT_LAPSE_HOURS
}

// ─── Briefing Builder ─────────────────────────────────────────────

function fmtNum(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K'
    : String(n)
}

/** Turn a tick countdown into rough wall-clock. Ticks are still printed too. */
function fmtTicks(t: unknown): string {
  const n = Number(t)
  if (!Number.isFinite(n)) return '?'
  const h = (n * TICK_SECONDS) / 3600
  const when = Math.abs(h) >= 1 ? `${h.toFixed(1)}h` : `${Math.round(Math.abs(h) * 60)}m`
  return n < 0 ? `${n} ticks (${when} AGO)` : `${n} ticks (~${when})`
}

/**
 * Render the systems this one actually touches.
 *
 * `jump` only reaches an adjacent system; anything else comes back
 * `not_connected`. Without the list in front of it, a model guesses from
 * half-remembered names, and three identical failures trip the loop-breaker —
 * which is exactly how Morg'Thar spent 22:08 on 2026-09-02. The adjacency was
 * in get_system the whole time.
 */
export function renderJumpLinks(system: Record<string, unknown> | null): string[] {
  if (!system) return []
  const raw = (system.connections ?? system.links ?? system.adjacent ?? system.connected_systems) as unknown
  if (!Array.isArray(raw) || raw.length === 0) return []

  const parts: string[] = []
  for (const c of raw) {
    if (typeof c === 'string') { parts.push(c); continue }
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const id = String(o.system_id ?? o.id ?? '')
    if (!id) continue
    const nm = String(o.name ?? '')
    const dist = String(o.distance ?? '')
    parts.push(`${id}${nm && nm !== id ? ` (${nm}${dist ? `, ${dist}` : ''})` : dist ? ` (${dist})` : ''}`)
  }
  if (parts.length === 0) return []

  return [
    `JUMP LINKS FROM HERE (${parts.length}) — jump(id=...) reaches ONLY these. Any other id returns not_connected:`,
    `  ${parts.join(' · ')}`,
    '  For anywhere else use goto_system(target_system="<id>"), which routes multi-hop for you. Do NOT retry a jump that returned not_connected.',
  ]
}

/**
 * Render active freight contracts.
 *
 * Freight runs on a clock the agent cannot see from get_status, and failing one
 * charges `failure_debt` and holds `reserved_exposure` against the liability
 * cap that limits how much freight can be carried at all. Cass Margin
 * (2026-09-02) sat idle at Gold Run for a whole session broadcasting "no
 * viable income" while a contract she had already accepted ticked toward a
 * 500cr penalty, with the package sitting in her own storage three systems
 * away. Nothing in her prompt mentioned it existed.
 *
 * The game computes `next_step` itself, so relay that verbatim rather than
 * re-deriving the plan here — it stays correct as the contract changes state.
 */
export function renderFreight(freight: unknown[] | null): string[] {
  if (!Array.isArray(freight) || freight.length === 0) return []
  const lines: string[] = []
  const rows: string[] = []

  for (const raw of freight) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    const c = (s.contract ?? {}) as Record<string, unknown>
    const id = String(c.id ?? s.contract_id ?? '')
    if (!id) continue

    const from = String(s.origin_name ?? c.origin_base_id ?? '?')
    const to = String(s.destination_name ?? c.destination_base_id ?? '?')
    const hops = Number(c.route_hops)
    const late = s.late === true || Number(s.ticks_to_deadline) < 0
    const debt = Number(s.failure_debt ?? c.failure_debt ?? 0)
    const payout = Number(s.payout_if_delivered_now ?? c.base_reward ?? 0)
    const exposure = Number(c.reserved_exposure ?? 0)
    const inCargo = s.package_in_your_cargo === true

    rows.push(
      `${late ? '⚠ LATE ' : ''}${from} → ${to}${Number.isFinite(hops) ? ` (${hops} hops)` : ''}` +
      `${s.role ? ` [${s.role}]` : ''}\n` +
      `   pays ${fmtNum(payout)}cr if delivered now · FAILURE DEBT ${fmtNum(debt)}cr` +
      `${exposure > 0 ? ` · ties up ${fmtNum(exposure)}cr of your liability cap` : ''}\n` +
      `   deadline ${fmtTicks(s.ticks_to_deadline)}` +
      `${s.ticks_to_recovery_deadline !== undefined ? ` · recovery window ${fmtTicks(s.ticks_to_recovery_deadline)}` : ''}\n` +
      `   package ${inCargo ? 'IS in your hold' : `NOT in your hold — last seen: ${s.last_known_location ?? 'unknown'}`}` +
      `${c.package_id ? `\n   package_id="${c.package_id}"` : ''}` +
      `${s.next_step ? `\n   NEXT STEP (the game's own): ${s.next_step}` : ''}\n` +
      `   settle: shipping(action="deliver"|"return"|"pay_debt", contract_id="${id}")`,
    )
  }
  if (rows.length === 0) return []

  lines.push(`== ACTIVE FREIGHT (${rows.length}) — these run on their OWN clock and BILL you if they lapse ==`)
  lines.push(...rows)
  lines.push('  Freight verbs all go through ONE command: shipping(action="list"|"active"|"accept"|"deliver"|"return"|"pay_debt", ...).')
  lines.push('  `list`/`accept` need an operational mission service under you — at a station without one they return not_docked, which means WRONG STATION, not "no work available".')
  return lines
}

// Station-like POI id suffixes. get_status on some connections carries NO explicit `docked` flag
// and NO `location` object — location lives on `player.current_system` / `player.current_poi`
// (e.g. "ironhearth_station"). When there's no flag we infer "docked" from a station-like POI id.
// Belts / fields / nebulae / asteroids never match these, so they correctly read as IN SPACE.
const STATION_POI_RX = /(station|citadel|outpost|trading_post|_post|_hub|_depot|_market|_yard|_dock|_port|_base|_terminal|_spire|_haven|_anchorage|_nexus|_command|_prime)$/i

/** Best-effort location read across the differing get_status shapes: some connections nest a
 *  `location` object; the HTTP shape puts it on `player.current_system` / `player.current_poi`. */
function readLocation(gs: Record<string, unknown> | null | undefined): { system: string; poi: string } {
  if (!gs) return { system: '?', poi: '' }
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  const system = location?.system_name ?? player?.system ?? player?.current_system ?? gs.system ?? '?'
  const poi = location?.poi_name ?? player?.poi ?? player?.current_poi ?? gs.poi ?? ''
  return { system: String(system), poi: String(poi) }
}

/** Best-effort docked detection across get_status shapes. Explicit flags win; otherwise infer
 *  from a station-like current_poi (or the player's home base, which is always a station). */
function isAgentDocked(gs: Record<string, unknown> | null | undefined): boolean {
  if (!gs) return false
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  if (player?.docked === true || player?.is_docked === true) return true
  if ((gs as Record<string, unknown>).docked === true) return true
  if (location && Boolean(location.docked_at)) return true
  // Fallback for the {player:{current_poi}} shape with no explicit flag.
  const poi = (player?.current_poi ?? location?.poi_name ?? '') as unknown
  if (typeof poi === 'string' && poi.length > 0) {
    if (STATION_POI_RX.test(poi)) return true
    if (player?.home_base && poi === player.home_base) return true
  }
  return false
}

/** Build a compact text briefing from cached data. Returns empty string if no data. */
export function buildSituationalBriefing(profileId: string): string {
  const cache = agentCaches.get(profileId)
  if (!cache || !cache.status || cache.updatedAt === 0) return ''

  const lines: string[] = []
  const gs = cache.status
  const player = gs.player as Record<string, unknown> | undefined
  const ship = gs.ship as Record<string, unknown> | undefined

  // Location & basic stats — read across both get_status shapes (nested `location` vs player.current_*)
  const { system: systemName, poi: poiName } = readLocation(gs)
  const fuel = ship?.fuel ?? gs.fuel ?? '?'
  const maxFuel = ship?.max_fuel ?? ship?.fuel_capacity ?? '?'
  const hull = ship?.hull ?? gs.hull ?? '?'
  const maxHull = ship?.max_hull ?? ship?.hull_capacity ?? '?'
  const shield = ship?.shield ?? gs.shield
  const credits = player?.credits ?? gs.credits ?? 0
  const isDocked = isAgentDocked(gs)

  lines.push(`** STATUS: ${isDocked ? 'DOCKED at ' + (poiName || systemName) : 'IN SPACE (not docked — cannot trade/market/storage/missions)'} **`)
  lines.push(`Location: ${systemName}${poiName ? ' > ' + poiName : ''}`)
  lines.push(`Wallet: ${fmtNum(Number(credits))}cr | Fuel: ${fuel}/${maxFuel} | Hull: ${hull}/${maxHull}${shield !== undefined ? ' | Shield: ' + shield : ''}`)

  const profileRow = getProfile(profileId)
  const role: AgentRole = profileRow ? resolveAgentRole(profileRow) : 'default'

  // Standing drains — every agent sees its own rents every turn. A Crew Bunk +
  // Ledger Desk billed one agent ~2M over 30 days precisely because no surface
  // showed it. Rent silent >6h is shown as (lapsed?) rather than dropped: absence
  // of a payment is weaker evidence than a dismantle event — but past
  // RENT_LAPSE_HOURS of silence the row is lapsed and rendered NOT AT ALL. The
  // Lithium Cell Foundry row (last paid 2026-08-06) was still being injected as
  // an ACTIVE RENTAL on 2026-09-01, and the agent spent 88 facility calls that
  // day trying to find and cancel a facility he no longer owned.
  {
    const now = Date.now()
    const obs = listObligations(profileId).filter(o => o.obligation_type === 'rent' && !isObligationLapsed(o, now))
    if (obs.length > 0) {
      const parts = obs.map(o => {
        const staleH = (now - new Date(o.last_seen).getTime()) / 3_600_000
        // total rounded to 10k: the nag keeps its weight while the briefing text —
        // which sits inside the CACHED prompt prefix — stays stable between payments
        // instead of invalidating the cache every rent cycle.
        const roughTotal = Math.round(o.total_paid / 10_000) * 10_000
        return `${o.facility} @${o.station_id} ${o.last_cost}cr/cycle (~${fmtNum(roughTotal)} paid to date${staleH > 6 ? ', lapsed?' : ''})`
      })
      lines.push(`⚠ ACTIVE RENTALS DRAINING YOUR WALLET: ${parts.join('; ')} — cancel any you are not actively using, or post NEED if unsure how.`)
    }
  }

  // Ship info
  if (ship) {
    const shipClass = ship.class_id ?? ship.class ?? ship.name ?? ''
    const cargoUsed = ship.cargo_used ?? '?'
    const cargoMax = ship.cargo_capacity ?? ship.max_cargo ?? '?'
    lines.push(`Ship: ${shipClass} | Cargo: ${cargoUsed}/${cargoMax}`)

    // Weapon loadout with per-gun ammo. Without this the agent re-derives its
    // own armament from get_ship every turn and gets it wrong: Morg'Thar
    // (2026-09-01) burned ~11 tool rounds guessing which of seven near-identical
    // weapon ids to reload, tried `id` and `weapon_instance_id` alternately, and
    // was stocking standard_rounds_box (feeds ONE gun, already full at 999/1000)
    // while six of his seven weapons fire ferrous_slug_case. A ship cannot fight
    // on ammo it does not carry, so the loadout belongs in the briefing next to
    // the cargo it has to match — at zero token cost, like the rest of it.
    const modules = ship.modules
    if (Array.isArray(modules)) {
      const weapons = (modules as Array<Record<string, unknown>>).filter(
        m => m.slot === 'weapon' || m.type === 'weapon' || m.ammo_type !== undefined || m.loaded_ammo_id !== undefined,
      )
      if (weapons.length > 0) {
        // Group identical guns so seven weapons read as three lines, not seven.
        const byKind = new Map<string, {
          n: number; ammo: string; lo: number; hi: number
          maxLo: number; maxHi: number; knownCaps: number; ready: number; ids: string[]
        }>()
        for (const w of weapons) {
          // lib_v2's get_ship names the instance `module_id`, the class `type_id`,
          // and sets `type` to the generic 'weapon' — the earlier `id`/`type`
          // reads rendered every gun as "weapon" with a blank id, so the agent
          // still could not reload (Morg'Thar 2026-09-01: 74 help(reload) reads).
          const specific = typeof w.type === 'string' && w.type !== 'weapon' ? w.type : undefined
          const kind = String(w.type_id ?? specific ?? w.name ?? 'weapon')
          const ammo = String(w.loaded_ammo_id ?? w.loaded_ammo_name ?? w.ammo_type ?? 'none')
          const cur = Number(w.current_ammo ?? w.ammo ?? 0) || 0
          const cap = Number(w.magazine_size ?? w.max_ammo ?? NaN)
          const id = String(w.id ?? w.instance_id ?? w.module_id ?? '')
          const key = `${kind}|${ammo}`
          const e = byKind.get(key) ?? {
            n: 0, ammo, lo: Infinity, hi: 0,
            maxLo: Infinity, maxHi: 0, knownCaps: 0, ready: 0, ids: [],
          }
          e.n++; e.lo = Math.min(e.lo, cur); e.hi = Math.max(e.hi, cur)
          if (Number.isFinite(cap) && cap > 0) {
            e.knownCaps++
            e.maxLo = Math.min(e.maxLo, cap)
            e.maxHi = Math.max(e.maxHi, cap)
            // One missing round in a 1,000-round magazine is operationally full;
            // it must not turn a combat-ready ship into an ammo-shopping mission.
            if (cur >= cap - 1) e.ready++
          }
          if (id) e.ids.push(id)
          byKind.set(key, e)
        }
        lines.push('Weapons (reload uses these ids):')
        for (const [key, e] of byKind) {
          const kind = key.split('|')[0]
          const count = e.n > 1 ? ` x${e.n}` : ''
          const ammoRange = e.lo === e.hi ? `${e.lo}` : `${e.lo}-${e.hi}`
          const capRange = e.knownCaps === e.n
            ? `/${e.maxLo === e.maxHi ? e.maxLo : `${e.maxLo}-${e.maxHi}`}`
            : ''
          lines.push(`  ${kind}${count} -> ${e.ammo} (loaded ${ammoRange}${capRange}) ids: ${e.ids.join(', ')}`)
        }
        const knownWeapons = [...byKind.values()].reduce((n, e) => n + e.knownCaps, 0)
        const readyWeapons = [...byKind.values()].reduce((n, e) => n + e.ready, 0)
        if (knownWeapons === weapons.length) {
          if (readyWeapons === weapons.length) {
            lines.push('WEAPON READINESS: COMBAT READY — every fitted weapon is full or effectively full. Do not reload or shop for ammo before acting; cargo ammo is spare stock.')
          } else if (readyWeapons > 0) {
            // Name the guns that CAN fire and say combat is on. "6/7 need
            // reload" was read as "I am unarmed": Morg'Thar crossed six
            // corridor systems on 2026-09-02 writing "all 7 weapons need
            // reload" while his Fury Cannon held 996 of 1,000 rounds, and
            // engaged nothing. A readiness line has to answer "can I fight
            // right now", not just count empty magazines.
            const readyNames = [...byKind.entries()]
              .filter(([, e]) => e.ready > 0)
              .map(([key, e]) => `${key.split('|')[0]}${e.ready > 1 ? ` x${e.ready}` : ''}`)
            lines.push(
              `WEAPON READINESS: YOU CAN FIGHT — ${readyWeapons}/${weapons.length} weapon(s) LOADED and ready: ${readyNames.join(', ')}. ` +
              `The other ${weapons.length - readyWeapons} ${weapons.length - readyWeapons === 1 ? 'is' : 'are'} empty and ` +
              `stay${weapons.length - readyWeapons === 1 ? 's' : ''} empty until you reach ammo — that is NOT a reason to skip a target. ` +
              `Engage what your loaded guns can beat; reload the rest only when you actually hold their ammo.`,
            )
          } else {
            lines.push(
              `WEAPON READINESS: ALL ${weapons.length} MAGAZINES EMPTY — you cannot win a fight. Do not attack. ` +
              `Travel to ammo, buy it, reload, then hunt.`,
            )
          }
        }
      }
    }
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

  // Own storage across ALL stations (fleet intelligence the agent otherwise
  // cannot see without a per-station query tour). Born 2026-08-30: Juno sat
  // "critically low" at 8.8k while 821 darksteel_ore of hers at War Citadel —
  // recorded in storage_inventory all along — went unmentioned by every prompt
  // path. Grouped by station, largest first, capped; quantities are what the
  // capture hooks last saw, so the header says they may lag.
  {
    const rows = getStorageSummaryForProfile(profileId)
    if (rows.length > 0) {
      // Quantize so a busy works' drip of deposits doesn't change the line
      // every refresh — byte-identical briefings keep the prompt cache warm
      // (same trick as galaxy-market's threshold throttling). "~800" is as
      // actionable as "x821" for the decision this line exists to unlock.
      const quant = (n: number) =>
        n >= 1000 ? `~${Math.floor(n / 100) * 100}` :
        n >= 100 ? `~${Math.floor(n / 25) * 25}` :
        n >= 20 ? `~${Math.floor(n / 5) * 5}` : String(n)
      // Station ids in these rows are mostly opaque 32-hex ids (e.g.
      // 0028449658...); an agent cannot fly to a hash. Render the display
      // name (and system, when the facility capture knows it) instead.
      const byStation = new Map<string, string[]>()
      for (const r of rows) {
        const key = stationDisplayName(r.station_id)
        const list = byStation.get(key) ?? []
        list.push(`${r.item_id} x${quant(r.quantity)}`)
        byStation.set(key, list)
      }
      const parts = [...byStation.entries()].map(([st, items]) => `${st}: ${items.join(', ')}`)
      lines.push(`YOUR STORAGE (fleet-tracked, may lag — verify with view_storage when acting): ${parts.join(' | ')}`)
    }
  }

  // Galaxy-wide market intel (public feed relay — agents cannot fetch HTTP).
  // Rendered from a threshold-throttled snapshot so stable prices keep these
  // lines byte-identical between fetches (see galaxy-market.ts header).
  // Hunters get bids for what they carry (loot has to be sold somewhere) but
  // not the sellable-ore board — they have no mining laser.
  {
    const cargoIds = (cache.cargo ?? []).map((c: unknown) => String((c as Record<string, unknown>).item_id ?? '')).filter(Boolean)
    for (const line of galaxyMarketLines(cargoIds, { oreBoard: role !== 'hunter' })) lines.push(line)
    // Both-sides quotes for items the directive names — buy-leg agents hold
    // nothing, so cargo-keyed lines alone leave them on stale directive numbers.
    const directive = getProfile(profileId)?.directive ?? ''
    for (const line of directiveMarketLines(directive)) lines.push(line)
  }

  // THE PLAYBOOK — the fleet's curated canon of proven plays (see playbook table
  // doctrine in db.ts). Read-only for agents; entries carry their class and age
  // so an agent can weigh a 20-day-old TERRAIN line against a fresh PATTERN.
  {
    const name = getProfile(profileId)?.name ?? ''
    const role = /miner/i.test(name) ? 'miner' : /trader|smuggler/i.test(name) ? 'trader'
      : /hauler/i.test(name) ? 'hauler' : /warrior/i.test(name) ? 'combat'
      : /prospector|explorer/i.test(name) ? 'explorer' : 'all'
    const entries = listPlaybook(role).slice(0, 12)
    if (entries.length > 0) {
      // == FLEET INTEL ==
      // Everything the fleet has learned about where the agent is standing and
      // where it can go next. Admiral has held 500+ systems, 1000+ links,
      // killzones, wrecks and danger grades for months without ANY of it
      // reaching a prompt, so agents rediscovered the map by flying into it.
      // Scoped to current + neighbours so it stays a handful of lines.
      {
        const { system: sysNow } = readLocation(gs)
        const sysId = String(sysNow || '').toLowerCase().replace(/\s+/g, '_')
        if (sysId) {
          const nav = getNavIntel(sysId)
          const fmt = (n: { system_id: string; empire: string | null; has_station: number; station_services: string | null; police_level: number | null; danger: string | null; pirate_pois: string | null; wrecks: number }) => {
            const svc = String(n.station_services || '')
            const bits: string[] = []
            if (n.has_station) {
              const useful = ['missions', 'refuel', 'repair', 'market', 'shipyard'].filter(k => svc.includes(k))
              bits.push(useful.length ? `STATION(${useful.join('/')})` : 'STATION')
            } else bits.push('no station')
            if (n.danger) bits.push(n.danger)
            if (n.police_level !== null) bits.push(`police ${n.police_level}`)
            if (n.pirate_pois) bits.push(`PIRATES: ${n.pirate_pois}`)
            if (n.wrecks > 0) bits.push(`${n.wrecks} wreck(s)`)
            return `  ${n.system_id}${n.empire ? ` [${n.empire}]` : ''} — ${bits.join(' · ')}`
          }
          const navLines: string[] = []
          if (nav.current) navLines.push(fmt(nav.current))
          for (const n of nav.neighbours) navLines.push(fmt(n))
          if (navLines.length > 0) {
            lines.push('== FLEET INTEL: HERE AND ONE JUMP OUT (what the fleet already knows — do NOT re-scout this) ==')
            lines.push(...navLines)
            lines.push('  (STATION = you can dock there. Fly to one of these rather than guessing.)')
          }

          // Standing answers to a combat agent's recurring questions: where are
          // the pirates, what is worth looting, and where do I pick up stackable
          // contracts. Ranked by hops so it is a next-move list, not an atlas.
          const hunt = getHuntIntel(sysId)
          const huntLines: string[] = []
          if (hunt.missionStations.length) {
            huntLines.push(`  MISSION BOARDS: ${hunt.missionStations
              .map(m => `${m.system_id} (${m.hops === 0 ? 'HERE' : m.hops + ' jump' + (m.hops > 1 ? 's' : '')}${m.police_level !== null ? `, police ${m.police_level}` : ''})`)
              .join(' · ')}`)
          }
          if (hunt.killzones.length) {
            huntLines.push(`  PIRATE GROUNDS: ${hunt.killzones
              .map(k => `${k.system_id}/${k.poi_name} (${k.pirates} seen${k.last_seen ? ', last ' + String(k.last_seen).slice(0, 10) : ''})`)
              .join(' · ')}`)
          }
          if (hunt.wrecks.length) {
            huntLines.push(`  WRECKS TO LOOT: ${hunt.wrecks
              .map(w => `${w.system_id} x${w.n}${w.value ? ` (~${w.value}cr)` : ''}`)
              .join(' · ')}`)
          }
          if (huntLines.length) {
            lines.push('== FLEET INTEL: HUNTING & CONTRACTS (nearest first) ==')
            lines.push(...huntLines)
          }
        }
      }

      lines.push('== FLEET PLAYBOOK (proven plays — LAW holds until a game patch; TERRAIN/PATTERN decay, check the age) ==')
      for (const e of entries) {
        const ageDays = Math.floor((Date.now() - Date.parse(e.last_verified.replace(' ', 'T') + 'Z')) / 86_400_000)
        lines.push(`[${e.class}${ageDays > 0 ? ` ${ageDays}d` : ''}] ${e.title}: ${e.body} (dead when: ${e.kill_condition})`)
      }
    }
  }

  // Active missions. The FULL mission id is printed: abandon/complete need all
  // 32 characters, and an 8-char prefix the agent copied from a truncated read
  // cost two mission_not_found rounds (2026-09-01). Counters and rewards are
  // what a hunter plans around; auto-attached distress entries are left out so
  // the paid contracts are what the line shows.
  if (cache.missions && cache.missions.length > 0) {
    const all = cache.missions.map((m) => m as Record<string, unknown>)
    const paid = all.filter((m) => !isAutoAttachedMission(m))
    const shown = (paid.length > 0 ? paid : all).slice(0, 5)
    const ready: string[] = []
    const missionStrs = shown.map((mission) => {
      const title = String(mission.title ?? mission.name ?? mission.type ?? mission.description ?? '?').slice(0, 40)
      const id = String(mission.mission_id ?? mission.id ?? '')
      const objs = Array.isArray(mission.objectives) ? mission.objectives as Array<Record<string, unknown>> : []
      const counter = objs
        .filter((o) => o && typeof o.current === 'number' && typeof o.required === 'number')
        .map((o) => `${o.current}/${o.required}`).join(',')
      const rewards = (mission.rewards && typeof mission.rewards === 'object' ? mission.rewards : {}) as Record<string, unknown>
      const reward = Number(rewards.credits ?? mission.reward_credits ?? mission.reward ?? NaN)
      const target = mission.target_poi ?? mission.destination ?? ''
      // WHERE the reward is claimed. A contract is completed at its ISSUING
      // base, not wherever the last kill happened, and the briefing never said
      // so — an agent can finish a contract and simply never collect it.
      const issuer = String(mission.issuing_base_id ?? mission.issuing_base ?? '')
      const issuerSys = String(mission.issuing_system_id ?? '')
      const objsDone = objs.length > 0 && objs.every((o) =>
        o.completed === true || (Number(o.current ?? 0) >= Number(o.required ?? Infinity)))
      if (objsDone && id) {
        ready.push(`${title} — ${Number.isFinite(reward) ? fmtNum(reward) + 'cr' : 'reward'} at ${issuer || 'its issuing base'}` +
          `${issuerSys ? ` (${issuerSys})` : ''}: complete_mission(id="${id}")`)
      }
      return `${title}${id ? ` [id ${id}]` : ''}${counter ? ` ${counter}` : ''}` +
        `${Number.isFinite(reward) ? ` ${fmtNum(reward)}cr` : ''} exp ${fmtExpiry(mission)}` +
        `${issuer ? ` claim@${issuer}` : ''}${target ? ' → ' + target : ''}`
    })
    const extra = all.length - shown.length
    lines.push(`Missions (${paid.length} paid held, cap 5): ${missionStrs.join(' | ')}${extra > 0 ? ` (+${extra} more)` : ''}`)
    if (ready.length > 0) {
      lines.push(
        `💰 READY TO CLAIM (${ready.length}) — these are DONE and the credits are unpaid until you turn them in:\n  ` +
        ready.join('\n  '),
      )
    }
  }

  // Freight sits directly under missions: same shape of obligation, different
  // clock, and the only one of the two that can bill the agent for inaction.
  for (const line of renderFreight(cache.freight)) lines.push(line)

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
    for (const line of renderJumpLinks(cache.system)) lines.push(line)
  }

  // Shootable things at this POI, with the ids `attack` takes.
  //
  // This is the difference between a hunter who fires and one who commutes.
  // The old block rendered "Nearby objects: N" — a bare count nobody can act
  // on — so the agent had to spend a round on get_nearby to learn a target id,
  // and when it skipped that round it flew on blind. Morg'Thar crossed 13
  // systems on 2026-09-02 killing nothing, including a gas pocket holding four
  // grazers. Inject the ids; never make him re-derive them.
  if (role === 'hunter' || cache.targets.length > 0) {
    if (cache.targets.length > 0) {
      const byKind = new Map<string, { n: number; hull: string; ids: string[]; combat: number }>()
      for (const t of cache.targets) {
        const key = `${t.kind}|${t.name}`
        const e = byKind.get(key) ?? { n: 0, hull: '', ids: [], combat: 0 }
        e.n++
        if (!e.hull && t.hull !== null) e.hull = t.maxHull !== null ? `${t.hull}/${t.maxHull}` : String(t.hull)
        if (t.inCombat) e.combat++
        e.ids.push(t.id)
        byKind.set(key, e)
      }
      const rows = [...byKind.entries()].map(([key, e]) => {
        const [kind, name] = key.split('|')
        const tag = kind === 'pirate' ? ' [PIRATE]' : kind === 'npc' ? ' [EMPIRE NPC — do not attack]' : ''
        return `  ${name}${e.n > 1 ? ` x${e.n}` : ''}${tag}${e.hull ? ` hull ${e.hull}` : ''}` +
          `${e.combat ? ` (${e.combat} already in combat)` : ''} — attack ids: ${e.ids.join(', ')}`
      })
      lines.push(
        `TARGETS AT YOUR POI (${cache.targets.length}) — attack(target_id=<id>) directly; you do NOT need get_nearby:\n` +
        rows.join('\n'),
      )
    } else {
      lines.push('TARGETS AT YOUR POI: none. Nothing here to shoot — move to the next POI or system; do not re-scan.')
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
    if (others > 0 && cache.targets.length === 0) {
      lines.push(`Nearby objects: ${others}`)
    }
  }

  // Market summary (top 5 items by margin if available)
  //
  // Depth is shown alongside price because price alone reads as unlimited: an agent
  // seeing "enriched_uranium_rod (buy:12776)" will size a sale as 12,776 x whatever it
  // holds, when the station is bidding that for exactly TWO units and 122cr less for the
  // third. `xN` is the quantity at the best price, so it caps the sale.
  //
  // This does mean the cached system prompt rebuilds when a book is eaten as well as when
  // a price moves. That is a real cache cost, accepted deliberately: it is genuine game
  // state (not a clock, which is what the note below forbids), and it is the number the
  // agent actually trades on. Drop the `xN` here first if cache writes ever spike.
  if (cache.market && cache.market.length > 0) {
    const items = cache.market.slice(0, 8).map((m: unknown) => {
      const item = m as Record<string, unknown>
      const name = item.item_id ?? item.name ?? '?'
      const buyPrice = item.buy_price ?? item.price ?? '?'
      const sellPrice = item.sell_price ?? ''
      const qty = (v: unknown) => (typeof v === 'number' ? ` x${v}` : '')
      const buyQty = qty(item.best_buy_qty ?? item.bid_quantity_at_best)
      const sellQty = qty(item.best_sell_qty ?? item.ask_quantity_at_best)
      return sellPrice
        ? `${name} (buy:${buyPrice}${buyQty} sell:${sellPrice}${sellQty})`
        : `${name} @${buyPrice}${buyQty}`
    })
    lines.push(`Market: ${items.join(', ')}`)
  }

  // NOTE: deliberately NO wall-clock "data age" line here. This briefing is baked
  // into the CACHED system prompt and gated by a strict `!==` comparison
  // (agent.ts), so any per-second-changing byte would rebuild the ~25-31k-token
  // system prompt almost every turn and bust Anthropic's prompt-cache prefix
  // (measured: ~65% of LLM spend was spurious cacheWrites). The header already
  // states the data is auto-refreshed every 60s; freshness/invalidation is tracked
  // independently via cache.updatedAt (the `updatedAt === 0` guard above), so the
  // briefing now changes ONLY when real game-state fields change — exactly when a
  // rebuild is warranted. If a live age is ever needed, inject it as an EPHEMERAL
  // per-turn user message, never into this cached string.

  return lines.join('\n')
}

/**
 * Build a compact, ZERO-COST fleet roster briefing for a faction commander.
 *
 * Pure read of the per-agent briefing caches (`agentCaches`) — no game ticks, no
 * LLM round-trip, no extra connection queries. One line per member. Members with
 * no cached status (offline / collector not yet warmed) are shown as offline so the
 * commander still sees the gap.
 *
 * Injected by agent.ts as an APPENDED ephemeral message (like a nudge), NOT baked
 * into the cached system prompt — so member movement never invalidates the
 * commander's prompt cache (the system-prompt cache invariant is untouched).
 */
export function buildFactionBriefing(members: Array<{ id: string; name: string }>): string {
  if (!members || members.length === 0) return ''
  const now = Date.now()
  const rows: string[] = []
  for (const m of members.slice(0, 8)) {
    const cache = agentCaches.get(m.id)
    if (!cache || !cache.status || cache.updatedAt === 0) {
      rows.push(`- ${m.name}: offline / no recent data`)
      continue
    }
    const gs = cache.status
    const player = gs.player as Record<string, unknown> | undefined
    const ship = gs.ship as Record<string, unknown> | undefined
    const { system, poi } = readLocation(gs)
    const credits = Number(player?.credits ?? gs.credits ?? 0)
    const shipClass = String(ship?.class_id ?? ship?.class ?? ship?.name ?? '?')
    const hull = ship?.hull ?? '?'
    const maxHull = ship?.max_hull ?? '?'
    const docked = isAgentDocked(gs)
    const age = Math.round((now - cache.updatedAt) / 1000)
    const loc = docked ? `docked ${poi || system}` : `${system}${poi ? '>' + poi : ''}`
    rows.push(`- ${m.name}: ${loc} | ${shipClass} hull ${hull}/${maxHull} | ${fmtNum(credits)}cr | ${age}s ago`)
  }
  if (rows.length === 0) return ''
  return (
    '## FLEET STATUS — your faction, live (read-only)\n' +
    'You are the fleet commander. Lead from this data: review each member, then DIRECT them via ' +
    'faction missions, fleet orders, and chat. You may NOT change any member\'s model, directive, ' +
    'memory, or connection (not even your own) — raise those to your human operator.\n' +
    rows.join('\n')
  )
}

/**
 * Best-effort current system NAME for an agent, read from the zero-cost briefing cache.
 * Returns undefined when unknown (e.g. mid-jump). Used to localize the Hunting Grounds
 * briefing to where the agent actually is. agentCaches / readLocation are module-private,
 * so this accessor is exported for the agent loop.
 */
export function getCachedSystemName(profileId: string): string | undefined {
  const cache = agentCaches.get(profileId)
  if (!cache || !cache.status) return undefined
  const { system } = readLocation(cache.status)
  return system && system !== '?' ? system : undefined
}
