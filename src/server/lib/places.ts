/**
 * Places, paths, and how dangerous they are.
 *
 * The game's own `find_route` returns a path and nothing about its safety. That
 * omission has cost this fleet real cargo: a 13-hop corridor was called "verified"
 * because its DESTINATION was policed, and Juno was sent down it carrying 228
 * weapon_core. Route safety is a property of every hop, not of the endpoints.
 *
 * So `routeWithSafety` grades each intermediate system and reports the WORST one,
 * because a corridor is exactly as safe as its most dangerous jump.
 *
 * Travel doctrine is TIERED, not a ban (Brian, 2026-09-16): five systems are
 * hard-banned outright; zero-police systems that are not on that list are
 * workable with an armed or expendable hull. Grading everything lawless as
 * forbidden is what left every silver and silicon seam "unreachable" while agents
 * sat idle — every known deposit for both sits at police 0.
 */
import { getDb } from './db'
import { systemForBase, stationsInSystem, listFeedStations } from './stations-feed'

/** Hard ban. Never route through these, whatever the cargo. */
export const KILLZONES = new Set([
  '70_ophiuchi', 'alhena', 'glenhaven', 'lacaille_8760', 'ross_248',
])

export type Risk = 'safe' | 'policed' | 'thin' | 'lawless' | 'KILLZONE'

export interface SystemRisk {
  system_id: string
  police_level: number | null
  grade: string | null          // from system_danger_daily, the observed grade
  risk: Risk
  killzone: boolean
}

export function riskOf(systemId: string): SystemRisk {
  const d = getDb()
  const s = d.query('SELECT police_level FROM fleet_intel_systems WHERE system_id = ? AND system_id <> \'\' LIMIT 1')
    .get(systemId) as { police_level?: number } | undefined
  const g = d.query('SELECT grade FROM system_danger_daily WHERE system_id = ? ORDER BY day DESC LIMIT 1')
    .get(systemId) as { grade?: string } | undefined
  const police = s?.police_level ?? null
  const killzone = KILLZONES.has(systemId)
  const risk: Risk = killzone ? 'KILLZONE'
    : police == null ? 'thin'            // we have never surveyed it — unknown is not safe
    : police >= 70 ? 'safe'
    : police > 0 ? 'policed'
    : 'lawless'
  return { system_id: systemId, police_level: police, grade: g?.grade ?? null, risk, killzone }
}

/** Neighbours of a system, from the map graph. */
export function neighbours(systemId: string): string[] {
  return (getDb().query(
    'SELECT DISTINCT CASE WHEN a = ? THEN b ELSE a END s FROM system_links WHERE a = ? OR b = ?',
  ).all(systemId, systemId, systemId) as Array<{ s: string }>).map(r => r.s).filter(Boolean)
}

export interface GradedRoute {
  from: string
  to: string
  found: boolean
  jumps: number
  hops: SystemRisk[]
  worst: SystemRisk | null
  crosses_killzone: boolean
  lawless_hops: number
  /** The same search with killzones excluded from the graph, when the direct one crosses any. */
  detour?: GradedRoute
}

/**
 * Breadth-first over the known map. BFS (not Dijkstra) because every jump costs
 * the same; what varies is risk, and risk is reported rather than optimised — a
 * router that silently preferred a longer safer path would hide the choice from
 * whoever has to authorise it.
 */
export function routeWithSafety(from: string, to: string, opts: { avoidKillzones?: boolean } = {}): GradedRoute {
  const blocked = opts.avoidKillzones ? KILLZONES : new Set<string>()
  const prev = new Map<string, string | null>([[from, null]])
  const queue: string[] = [from]
  let found = false

  while (queue.length) {
    const cur = queue.shift()!
    if (cur === to) { found = true; break }
    for (const n of neighbours(cur)) {
      if (prev.has(n) || (blocked.has(n) && n !== to)) continue
      prev.set(n, cur)
      queue.push(n)
    }
  }

  const path: string[] = []
  if (found || prev.has(to)) {
    let cur: string | null = to
    while (cur != null) { path.unshift(cur); cur = prev.get(cur) ?? null }
  }

  const hops = path.map(riskOf)
  const order: Record<Risk, number> = { safe: 0, policed: 1, thin: 2, lawless: 3, KILLZONE: 4 }
  // The endpoints are where you choose to be; the CORRIDOR is what you cannot opt out of.
  const middle = hops.slice(1, -1)
  const worst = middle.length
    ? middle.reduce((a, b) => (order[b.risk] > order[a.risk] ? b : a))
    : null

  const route: GradedRoute = {
    from, to,
    found: path.length > 0 && path[path.length - 1] === to,
    jumps: Math.max(0, path.length - 1),
    hops, worst,
    crosses_killzone: middle.some(h => h.killzone),
    lawless_hops: middle.filter(h => h.risk === 'lawless' || h.risk === 'KILLZONE').length,
  }

  if (route.crosses_killzone && !opts.avoidKillzones) {
    const alt = routeWithSafety(from, to, { avoidKillzones: true })
    if (alt.found) route.detour = alt
  }
  return route
}

export interface PlaceReport {
  id: string
  kind: 'system' | 'station' | 'unknown'
  system_id: string | null
  risk: SystemRisk | null
  stations: Array<{ station_id: string; station_name: string | null }>
  deposits: Array<{ item_id: string; poi_name: string; richness: number; remaining: number; supported_power: number | null; last_seen: string }>
  facilities: Array<{ facility_type: string; facility_name: string | null; public: number | null; faction_owned: number | null; last_seen: string }>
  holdings: Array<{ holder_kind: string; holder: string; item_id: string; quantity: number }>
  agents_here: string[]
  neighbours: SystemRisk[]
}

/** Everything we know about one place — system or station. */
export function describePlace(id: string): PlaceReport {
  const d = getDb()
  const asSystem = d.query('SELECT system_id FROM fleet_intel_systems WHERE system_id = ? AND system_id <> \'\'').get(id) as { system_id?: string } | undefined

  // The station -> system map comes from the game's own station feed, NOT from a
  // prefix match on fleet_intel_systems. Prefix matching silently fails whenever a
  // station is not named after its system (grand_exchange_station is not in a
  // "grand_exchange" system, and frontier_station is in the_telescope) — which is
  // exactly the guessing that burned a turn per attempt for a hauler on 2026-09-17.
  // It also matches the empty-system_id row for EVERY station if not excluded.
  const feedSystem = systemForBase(id)
  const viaPrefix = feedSystem ? null : (d.query(
    `SELECT system_id FROM fleet_intel_systems WHERE system_id <> '' AND ? LIKE system_id || '%'
     ORDER BY length(system_id) DESC LIMIT 1`).get(id) as { system_id?: string } | undefined)
  const kind: PlaceReport['kind'] = asSystem ? 'system' : (feedSystem || viaPrefix?.system_id) ? 'station' : 'unknown'
  const system = asSystem?.system_id ?? feedSystem ?? viaPrefix?.system_id ?? null

  // Prefer the authoritative feed; fall back to whatever intel we scraped.
  const feedStations = system ? stationsInSystem(system) : []
  const stations = feedStations.length
    ? feedStations.map(st => ({ station_id: String(st.base_id ?? st.id ?? ''), station_name: String(st.name ?? '') || null }))
    : (system
        ? (d.query(`SELECT DISTINCT station_id, station_name FROM fleet_intel_facilities WHERE station_id LIKE ? || '%'`)
            .all(system) as Array<{ station_id: string; station_name: string | null }>)
        : [])

  const deposits = system
    ? (d.query(`SELECT item_id, poi_name, richness, remaining, supported_power, last_seen
          FROM fleet_intel_deposits WHERE system_id = ? AND remaining > 0
          ORDER BY richness DESC LIMIT 25`).all(system) as PlaceReport['deposits'])
    : []

  const facilities = d.query(
    `SELECT facility_type, facility_name, public, faction_owned, last_seen FROM fleet_intel_facilities
      WHERE station_id = ? OR station_id LIKE ? || '%' LIMIT 25`).all(id, system ?? id) as PlaceReport['facilities']

  const holdings = d.query(`
    SELECT 'vault' AS holder_kind, 'FACTION' AS holder, item_id, quantity
      FROM faction_storage_inventory WHERE station_id = ? AND quantity > 0
    UNION ALL
    SELECT 'locker', COALESCE(p.name, s.profile_id), s.item_id, s.quantity
      FROM storage_inventory s LEFT JOIN profiles p ON p.id = s.profile_id
     WHERE s.station_id = ? AND s.quantity > 0
    ORDER BY quantity DESC LIMIT 40`).all(id, id) as PlaceReport['holdings']

  // position_history records the STATION an agent was seen at, not the system, and
  // its timestamp column is observed_at. Match the station prefix so a system query
  // still finds everyone docked anywhere inside it.
  const agents = (d.query(
    `SELECT DISTINCT p.name FROM position_history ph JOIN profiles p ON p.id = ph.profile_id
      WHERE (ph.station_id = ? OR ph.station_id LIKE ? || '%')
        AND ph.observed_at > datetime('now','-3 hours')`)
    .all(id, system ?? id) as Array<{ name: string }>).map(r => r.name)

  return {
    id, kind, system_id: system,
    risk: system ? riskOf(system) : null,
    stations, deposits, facilities, holdings,
    agents_here: agents,
    neighbours: system ? neighbours(system).map(riskOf) : [],
  }
}

/**
 * Turn what someone TYPED into place ids that actually exist.
 *
 * The route and place lookups took their input as an exact id and said only
 * `found: false` when it missed. Typing "iron" — with iron_reach, ironhearth,
 * ironhollow, ironpeak and ironveil all in the graph — returned an empty result and
 * no hint that five matches existed. That reads as "no route from here", which is a
 * different and much more alarming statement than "say which one you meant".
 *
 * Exact id wins. Otherwise: a station whose id starts with the text, then any system
 * or station containing it, shortest first so `iron_reach` outranks
 * `iron_reach_mining_colony` for the query "iron". The empty system_id row is excluded
 * — `x LIKE '%'` matches it for every query and it poisons any LIKE lookup here.
 */
export function resolvePlace(text: string): { exact: string | null; candidates: string[] } {
  const q = String(text || '').trim().toLowerCase()
  if (!q) return { exact: null, candidates: [] }
  const db = getDb()
  const hit = (sql: string, ...p: unknown[]) =>
    (db.query(sql).all(...p) as Array<{ id: string }>).map(r => r.id).filter(Boolean)

  const exactSys = hit(`SELECT system_id AS id FROM fleet_intel_systems WHERE system_id = ? LIMIT 1`, q)
  if (exactSys.length) return { exact: exactSys[0], candidates: [] }
  const exactSta = hit(`SELECT DISTINCT station_id AS id FROM faction_storage_inventory WHERE station_id = ? LIMIT 1`, q)
  if (exactSta.length) return { exact: exactSta[0], candidates: [] }

  const like = `%${q}%`
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [
    ...hit(`SELECT system_id AS id FROM fleet_intel_systems WHERE system_id <> '' AND system_id LIKE ? ORDER BY length(system_id) LIMIT 12`, like),
    ...hit(`SELECT DISTINCT station_id AS id FROM storage_inventory WHERE station_id IS NOT NULL AND station_id LIKE ? ORDER BY length(station_id) LIMIT 12`, like),
  ]) {
    if (!seen.has(id)) { seen.add(id); out.push(id) }
  }
  // One unambiguous match is not a question — treat it as what they meant.
  if (out.length === 1) return { exact: out[0], candidates: [] }
  return { exact: null, candidates: out.slice(0, 10) }
}
