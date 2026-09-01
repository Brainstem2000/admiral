/**
 * Situational Briefing System
 *
 * Collects game state via direct connection queries (zero LLM tokens)
 * and builds compact text briefings injected into the agent's system prompt.
 *
 * Kill switch: preference "situational_briefing" = "off" disables injection.
 */
import type { GameConnection, CommandResult } from './connections/interface'
import { listObligations, getProfile, listPlaybook, getStorageSummaryForProfile, getNavIntel } from './db'
import { galaxyMarketLines, directiveMarketLines } from './galaxy-market'

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
// Monotonic per-agent epoch, bumped on every invalidation (e.g. after a move). A refresh that
// began before a bump is discarded at write time, so an out-of-order async refresh can never
// overwrite newer state with a stale snapshot — the root cause of "system thinks I'm in <old system>".
const agentEpochs = new Map<string, number>()

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
  const startEpoch = agentEpochs.get(profileId) ?? 0
  const cache = agentCaches.get(profileId) || emptyCache()

  // Fast path: a connection-maintained local state cache (lib_v2) covers
  // status/cargo/missions with zero round-trips — only nearby/system/market
  // still need the wire.
  const localState = conn.getLocalState?.() ?? null

  let statusRaw: unknown, cargoRaw: unknown, nearbyRaw: unknown, systemRaw: unknown, missionsRaw: unknown

  let shipRaw: unknown = null
  if (localState) {
    statusRaw = localState
    cargoRaw = localState.cargo ?? null
    // lib state's missions section is {active: [...]} — unwrap to the array the parser expects
    const ms = localState.missions as Record<string, unknown> | unknown[] | null | undefined
    missionsRaw = Array.isArray(ms) ? ms : (ms && typeof ms === 'object' && Array.isArray((ms as Record<string, unknown>).active)) ? (ms as Record<string, unknown>).active : null
    ;[nearbyRaw, systemRaw, shipRaw] = await Promise.all([
      safeQuery(conn, 'get_nearby'),
      safeQuery(conn, 'get_system'),
      // get_status carries no `modules` array, so the weapon loadout has to
      // come from get_ship. Free query, no game tick.
      safeQuery(conn, 'get_ship'),
    ])
  } else {
    // Run queries in parallel — these are all free query commands
    ;[statusRaw, cargoRaw, nearbyRaw, systemRaw, missionsRaw, shipRaw] = await Promise.all([
      safeQuery(conn, 'get_status'),
      safeQuery(conn, 'get_cargo'),
      safeQuery(conn, 'get_nearby'),
      safeQuery(conn, 'get_system'),
      safeQuery(conn, 'get_active_missions'),
      safeQuery(conn, 'get_ship'),
    ])
  }

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
  if (systemRaw && typeof systemRaw === 'object') cache.system = systemRaw as Record<string, unknown>
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

// ─── Briefing Builder ─────────────────────────────────────────────

function fmtNum(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K'
    : String(n)
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

  // Standing drains — every agent sees its own rents every turn. A Crew Bunk +
  // Ledger Desk billed one agent ~2M over 30 days precisely because no surface
  // showed it. Rent silent >6h is shown as (lapsed?) rather than dropped: absence
  // of a payment is weaker evidence than a dismantle event.
  {
    const obs = listObligations(profileId).filter(o => o.obligation_type === 'rent' && o.status === 'active')
    if (obs.length > 0) {
      const now = Date.now()
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
        const byKind = new Map<string, { n: number; ammo: string; lo: number; hi: number; ids: string[] }>()
        for (const w of weapons) {
          const kind = String(w.type ?? w.name ?? w.module_id ?? 'weapon')
          const ammo = String(w.loaded_ammo_id ?? w.loaded_ammo_name ?? w.ammo_type ?? 'none')
          const cur = Number(w.current_ammo ?? w.ammo ?? 0) || 0
          const id = String(w.id ?? w.instance_id ?? '')
          const key = `${kind}|${ammo}`
          const e = byKind.get(key) ?? { n: 0, ammo, lo: Infinity, hi: 0, ids: [] }
          e.n++; e.lo = Math.min(e.lo, cur); e.hi = Math.max(e.hi, cur)
          if (id) e.ids.push(id)
          byKind.set(key, e)
        }
        lines.push('Weapons (reload uses these ids):')
        for (const [key, e] of byKind) {
          const kind = key.split('|')[0]
          const count = e.n > 1 ? ` x${e.n}` : ''
          const ammoRange = e.lo === e.hi ? `${e.lo}` : `${e.lo}-${e.hi}`
          lines.push(`  ${kind}${count} -> ${e.ammo} (loaded ${ammoRange}) ids: ${e.ids.join(', ')}`)
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
      const byStation = new Map<string, string[]>()
      for (const r of rows) {
        const list = byStation.get(r.station_id) ?? []
        list.push(`${r.item_id} x${quant(r.quantity)}`)
        byStation.set(r.station_id, list)
      }
      const parts = [...byStation.entries()].map(([st, items]) => `${st}: ${items.join(', ')}`)
      lines.push(`YOUR STORAGE (fleet-tracked, may lag — verify with view_storage when acting): ${parts.join(' | ')}`)
    }
  }

  // Galaxy-wide market intel (public feed relay — agents cannot fetch HTTP).
  // Rendered from a threshold-throttled snapshot so stable prices keep these
  // lines byte-identical between fetches (see galaxy-market.ts header).
  {
    const cargoIds = (cache.cargo ?? []).map((c: unknown) => String((c as Record<string, unknown>).item_id ?? '')).filter(Boolean)
    for (const line of galaxyMarketLines(cargoIds)) lines.push(line)
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
        }
      }

      lines.push('== FLEET PLAYBOOK (proven plays — LAW holds until a game patch; TERRAIN/PATTERN decay, check the age) ==')
      for (const e of entries) {
        const ageDays = Math.floor((Date.now() - Date.parse(e.last_verified.replace(' ', 'T') + 'Z')) / 86_400_000)
        lines.push(`[${e.class}${ageDays > 0 ? ` ${ageDays}d` : ''}] ${e.title}: ${e.body} (dead when: ${e.kill_condition})`)
      }
    }
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
