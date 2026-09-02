import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'

/**
 * The authoritative station list: https://game.spacemolt.com/api/stations
 *
 * Free, unauthenticated, and every entry carries the `system_id` it lives in — which
 * makes it the one source that can REFUTE a station claim. Fleet intel had none: a
 * bad ingest on 2026-09-02 flagged four systems (horizon, distant_light, the_telescope,
 * fuyue) as having a station, with copied service lists, and because has_station was
 * a MAX() latch nothing an agent observed afterwards could ever clear it. The hunter
 * looped between systems with no base to dock at.
 *
 * Same discipline as catalog.ts: disk cache under data/ so a boot without network
 * still has the list, hourly revalidation, and no network call on the hot path — the
 * ingest code asks synchronous questions of the in-memory snapshot and the refresh
 * runs in the background. Nothing here imports db.ts (db.ts imports this).
 */

const FEED_URL = 'https://game.spacemolt.com/api/stations'
const CACHE_FILE = path.join(process.cwd(), 'data', 'stations-cache.json')
const REFRESH_MS = 60 * 60 * 1000
/** Past this age the snapshot is history, not evidence: fall back to observations only. */
const MAX_TRUST_AGE_MS = 24 * 60 * 60 * 1000
/**
 * A feed that shrank far below the ~76 systems it has always carried is a broken
 * response, not a galaxy that lost its stations. Nothing is refuted or cleared on
 * the strength of a list this short.
 */
export const MIN_PLAUSIBLE_STATIONS = 40

export interface StationRecord {
  id: string
  base_id: string
  poi_id: string
  name: string
  type: string
  system_id: string
  system_name: string
  services: string[]
  wrecked: boolean
}

interface FeedSnapshot {
  fetched_at: number
  stations: StationRecord[]
}

let snapshot: FeedSnapshot | null = null
let diskChecked = false
let inflight: Promise<FeedSnapshot | null> | null = null
let networkDisabled = false
let bySystem = new Map<string, StationRecord[]>()
let byBase = new Map<string, StationRecord>()

function index(s: FeedSnapshot | null): void {
  bySystem = new Map()
  byBase = new Map()
  for (const st of s?.stations ?? []) {
    const list = bySystem.get(st.system_id) ?? []
    list.push(st)
    bySystem.set(st.system_id, list)
    for (const key of [st.id, st.base_id, st.poi_id]) if (key) byBase.set(key.toLowerCase(), st)
  }
}

function normalise(raw: unknown): StationRecord[] | null {
  const list = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { stations?: unknown }).stations))
      ? (raw as { stations: unknown[] }).stations : null
  if (!list) return null
  const out: StationRecord[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const systemId = typeof o.system_id === 'string' ? o.system_id.toLowerCase().trim() : ''
    if (!systemId) continue
    const id = String(o.id ?? o.base_id ?? '')
    out.push({
      id,
      base_id: String(o.base_id ?? id),
      poi_id: String(o.poi_id ?? ''),
      name: String(o.name ?? ''),
      type: String(o.type ?? ''),
      system_id: systemId,
      system_name: String(o.system_name ?? ''),
      services: Array.isArray(o.services) ? o.services.map(String).filter(Boolean) : [],
      wrecked: o.wrecked === true,
    })
  }
  return out
}

function loadFromDisk(): void {
  diskChecked = true
  if (!existsSync(CACHE_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Partial<FeedSnapshot>
    const stations = normalise(parsed.stations)
    if (!stations || typeof parsed.fetched_at !== 'number') return
    snapshot = { fetched_at: parsed.fetched_at, stations }
    index(snapshot)
  } catch { /* corrupt cache is the same as no cache */ }
}

/** Fetch the live list; on success replace the snapshot and the disk cache. */
export async function refreshStationsFeed(): Promise<FeedSnapshot | null> {
  if (networkDisabled) return snapshot
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(FEED_URL, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'SpaceMolt-Admiral' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const stations = normalise(await res.json())
      if (!stations) throw new Error('stations response malformed')
      snapshot = { fetched_at: Date.now(), stations }
      index(snapshot)
      try {
        mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
        writeFileSync(CACHE_FILE, JSON.stringify(snapshot))
      } catch { /* cache write is best-effort */ }
      console.log(`[Stations] feed: ${stations.length} stations across ${bySystem.size} systems`)
      return snapshot
    } catch (err) {
      console.warn(`[Stations] feed refresh failed: ${err instanceof Error ? err.message : err}`)
      return snapshot
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Make sure a snapshot is loaded if one exists on disk, and kick a background refresh
 * when it is older than the TTL. Synchronous and cheap — safe to call on every ingest.
 */
export function ensureStationsFeed(): void {
  if (!diskChecked) loadFromDisk()
  if (networkDisabled) return
  const age = snapshot ? Date.now() - snapshot.fetched_at : Infinity
  if (age > REFRESH_MS) void refreshStationsFeed()
}

/** Whether the snapshot is recent and large enough to be used as evidence. */
export function stationsFeedAvailable(): boolean {
  ensureStationsFeed()
  if (!snapshot) return false
  if (Date.now() - snapshot.fetched_at > MAX_TRUST_AGE_MS) return false
  return snapshot.stations.length >= MIN_PLAUSIBLE_STATIONS
}

/** Every system that has at least one station or outpost; null when the feed is unavailable. */
export function stationSystems(): Set<string> | null {
  if (!stationsFeedAvailable()) return null
  return new Set(bySystem.keys())
}

/** True/false from the feed; null when the feed cannot answer. */
export function feedSaysSystemHasStation(systemId: string): boolean | null {
  if (!stationsFeedAvailable()) return null
  return bySystem.has(systemId.toLowerCase().trim())
}

export function stationsInSystem(systemId: string): StationRecord[] {
  if (!stationsFeedAvailable()) return []
  return bySystem.get(systemId.toLowerCase().trim()) ?? []
}

/** Resolve a base/station/poi id to the system it stands in — null when unknown. */
export function systemForBase(baseId: string): string | null {
  if (!baseId || !stationsFeedAvailable()) return null
  return byBase.get(baseId.toLowerCase().trim())?.system_id ?? null
}

/** Union of services across every station in the system, comma-joined; null if none known. */
export function feedServicesForSystem(systemId: string): string | null {
  const set = new Set<string>()
  for (const st of stationsInSystem(systemId)) for (const s of st.services) set.add(s)
  return set.size ? [...set].sort().join(',') : null
}

/** The current snapshot's stations (empty when unavailable). */
export function listFeedStations(): StationRecord[] {
  return stationsFeedAvailable() ? (snapshot?.stations ?? []) : []
}

/**
 * Test seam: install a snapshot (or none) and never touch the network or disk.
 * `fetchedAt` lets a test age the snapshot past the trust window.
 */
export function __setStationsFeedForTests(stations: Array<Partial<StationRecord>> | null, fetchedAt = Date.now()): void {
  networkDisabled = true
  diskChecked = true
  snapshot = stations ? { fetched_at: fetchedAt, stations: normalise(stations) ?? [] } : null
  index(snapshot)
}
