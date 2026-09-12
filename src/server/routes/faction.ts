import { Hono } from 'hono'
import { agentManager } from '../lib/agent-manager'
import { listProfiles, getDb, getFactionStorage, getFactionLedger, getFactionTreasurySummary } from '../lib/db'

/**
 * Faction-level view: overview (treasury, members/roles, personnel, fuel) plus
 * the storage picture per station. Faction storage is gated by per-station
 * lockbox facilities — stations without one report LOCKED with whatever the
 * hint reveals (aggregate item count), and light up with full item tables as
 * lockboxes get built. All data comes from free queries through a connected
 * agent (the faction leader when available), cached for 60s.
 */

const faction = new Hono()

// The leader sees the most (role management, full treasury actions).
const LEADER_NAME_HINT = 'CyberSpock'

interface StorageStation {
  station_id: string
  status: 'unlocked' | 'locked' | 'error'
  items: Array<{ item_id: string; name?: string; quantity: number }>
  credits: number | null
  message?: string
}

let cache: { at: number; body: Record<string, unknown> } | null = null

async function runQuery(agentId: string, command: string, args?: Record<string, unknown>) {
  const agent = agentManager.getAgent(agentId)
  if (!agent || !agent.isConnected) throw new Error('agent not connected')
  return await agent.executeCommand(command, args, { silent: true }) as Record<string, unknown>
}

/**
 * Any connected agent will do. `view_faction_storage` reads ANY station's vault
 * when passed `station_id`, and that form works from deep space — only the
 * no-argument form needs a dock, and this route no longer depends on it.
 */
function pickAgent(): string | null {
  const profiles = listProfiles()
  const connected = profiles.filter((p) => agentManager.getAgent(p.id)?.isConnected)
  if (connected.length === 0) return null
  const leader = connected.find((p) => p.name.includes(LEADER_NAME_HINT))
  return (leader ?? connected[0]).id
}

/**
 * Stations worth asking about, from durable local records rather than from one
 * live query. `view_faction_storage` with no argument is refused `not_docked`
 * whenever the chosen agent is in space, and this route used to derive its
 * whole station list from that call's hint — so a flying agent collapsed the
 * page to a single bogus "current_station · locked" card reading "no lockbox",
 * and it flipped back the moment a poll caught somebody docked. Reported
 * 2026-09-12 as the Faction screen intermittently losing the War Citadel
 * lockbox. Seeding from the DB makes the page independent of who is flying.
 */
function knownVaultStations(): string[] {
  const out = new Set<string>()
  try {
    for (const r of getDb().query('SELECT DISTINCT station_id FROM faction_storage_inventory').all() as Array<{ station_id: string }>) {
      if (r.station_id) out.add(r.station_id)
    }
  } catch { /* no rows yet */ }
  try {
    // `owned = 1` matters: the facilities table also records other factions'
    // lockboxes, and probing those just produces a wall of "no storage facility
    // here" cards for stations we never had anything at.
    for (const r of getDb().query(
      `SELECT DISTINCT station_id FROM fleet_intel_facilities
        WHERE owned = 1 AND facility_type IN ('faction_lockbox','faction_warehouse')`
    ).all() as Array<{ station_id: string }>) {
      if (r.station_id) out.add(r.station_id)
    }
  } catch { /* no rows yet */ }
  return [...out]
}

faction.get('/', async (c) => {
  if (cache && Date.now() - cache.at < 60_000 && !c.req.query('fresh')) {
    return c.json({ ...cache.body, cached: true })
  }
  const agentId = pickAgent()
  if (!agentId) return c.json({ error: 'No connected agent to query through' }, 503)
  try {
    const infoRaw = await runQuery(agentId, 'faction_info')
    const info = (infoRaw.structuredContent ?? {}) as Record<string, unknown>

    // Current-station vault first: its error hint carries the aggregate item
    // count and the authoritative list of stations holding faction goods.
    const stations = new Map<string, StorageStation>()
    let aggregateNote: string | null = null
    const parseVault = (raw: Record<string, unknown>, fallbackStation: string): void => {
      const res = (raw.structuredContent ?? raw.result) as Record<string, unknown> | undefined
      const err = raw.error as Record<string, unknown> | undefined
      if (res && typeof res === 'object' && Array.isArray(res.items)) {
        const sid = String(res.base_id ?? fallbackStation)
        const hint = String(res.hint ?? '')
        // The current-station query returns a success-shaped envelope with an
        // empty item list even when NO lockbox exists there — the "no storage
        // facility" hint is the real verdict. Without this check the UI showed
        // "lockbox online · empty" for a station holding thousands of
        // ledgered-but-invisible items (reported 2026-08-30).
        const noFacility = /does not have a storage facility/i.test(hint)
        stations.set(sid, {
          station_id: sid,
          status: noFacility ? 'locked' : 'unlocked',
          items: noFacility ? [] : res.items as StorageStation['items'],
          credits: typeof res.credits === 'number' ? res.credits : null,
          ...(noFacility ? { message: 'No lockbox built here yet — contents ledgered but inaccessible.' } : {}),
        })
        if (hint) aggregateNote = hint
      } else if (err) {
        const msg = String(err.message ?? '')
        stations.set(fallbackStation, {
          station_id: fallbackStation, status: 'locked', items: [], credits: null, message: msg,
        })
      }
    }

    // Try the bare query for its hint only. It is refused `not_docked` whenever
    // the agent is flying, which is most of the time for a mining fleet — so
    // its failure must cost nothing.
    let hintedStations: string[] = []
    let hintedTotal: number | null = null
    {
      const homeRaw = await runQuery(agentId, 'view_faction_storage').catch((e) => ({ error: { message: String(e) } }))
      // The hint (on success or error) names every station with faction goods:
      // "22,086 items in faction storage at a, b, c". Harvest it either way.
      const homeText = JSON.stringify(homeRaw)
      const hintMatch = homeText.match(/([\d,]+) items in faction storage at ([a-z0-9_,\s]+)/i)
      if (hintMatch) {
        hintedTotal = Number(hintMatch[1].replace(/,/g, ''))
        hintedStations = hintMatch[2].split(',').map((s) => s.trim()).filter(Boolean)
        aggregateNote = `${hintMatch[1]} items ledgered across ${hintedStations.length} stations`
      }
      const home = homeRaw as Record<string, unknown>
      const homeOk = (home.structuredContent ?? home.result) as Record<string, unknown> | undefined
      // Only a station-shaped success is worth recording; a not_docked error is
      // about the AGENT, not about any station.
      if (homeOk && typeof homeOk === 'object' && Array.isArray(homeOk.items)) parseVault(home, 'current_station')
    }

    // Ask each station BY ID — that form works from deep space — and do them
    // together. Six sequential game round-trips were also why this page took
    // so long to fill in.
    const targets = [...new Set([...hintedStations, ...knownVaultStations()])].filter((sid) => !stations.has(sid))
    const reads = await Promise.all(targets.map(async (sid) => ({
      sid,
      raw: await runQuery(agentId, 'view_faction_storage', { station_id: sid })
        .catch((e) => ({ error: { message: String(e) } })) as Record<string, unknown>,
    })))
    for (const { sid, raw } of reads) parseVault(raw, sid)

    // A station we could not read live still has a last-known picture in the
    // DB. Showing that, labelled, beats showing "no lockbox" for a vault that
    // demonstrably holds thousands of items.
    for (const st of stations.values()) {
      if (st.status === 'unlocked' || st.items.length > 0) continue
      const rows = getFactionStorage(st.station_id)
      if (rows.length === 0) continue
      st.items = rows.map((r) => ({ item_id: r.item_id, name: r.item_name, quantity: r.quantity }))
      st.status = 'unlocked'
      st.message = `Live read failed; showing the last snapshot (${rows[0].updated_at} UTC, reported by ${rows[0].reported_by ?? 'unknown'}).`
    }

    const body = {
      fetched_at: new Date().toISOString(),
      info: {
        name: info.name, tag: info.tag, description: info.description,
        leader: info.leader_username, member_count: info.member_count,
        members_limit: info.members_limit, treasury: info.treasury,
        members: info.members, roles: info.roles, personnel: info.personnel,
        charter: info.charter, at_war: info.at_war,
        owned_bases: info.owned_bases,
        fuel_reserve: info.total_fuel_reserve, fuel_capacity: info.total_fuel_capacity,
        created_at: info.created_at,
      },
      storage: {
        aggregate_note: aggregateNote,
        hinted_total_items: hintedTotal,
        stations: [...stations.values()],
        // WHICH stations we can actually DEPOSIT at. A remote read succeeds at
        // every station holding our ledgered stock, so "unlocked" above means
        // only "we can see it" — deposits are refused with no_faction_storage
        // anywhere we do not own a lockbox. Showing six readable stations as if
        // all six accepted deposits is the mistake that had an agent planning to
        // mine 200 steel_plate for a lockbox that already existed elsewhere.
        deposit_stations: (() => {
          try {
            return (getDb().query(
              `SELECT DISTINCT station_id FROM fleet_intel_facilities
                WHERE owned = 1 AND facility_type IN ('faction_lockbox','faction_warehouse')`
            ).all() as Array<{ station_id: string }>).map(r => r.station_id)
          } catch { return [] }
        })(),
        // What an open commission is still waiting on, so the vault page can
        // show at a glance whether the fleet's shared stock covers the builds
        // it is being stockpiled for. Faction storage is where ship-build
        // supplies live, so "is this item wanted" is the question that matters.
        build_needs: (() => {
          try {
            return getDb().query(
              `SELECT item_id, SUM(quantity) AS needed FROM commission_requirements GROUP BY item_id`
            ).all() as Array<{ item_id: string; needed: number }>
          } catch { return [] }
        })(),
      },
    }
    cache = { at: Date.now(), body }
    return c.json(body)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})


// --- Faction ledger / lockbox / treasury (DB-backed, no game tick) ---

/** Lockbox contents as last reported by any agent's `view target=faction`, per station. */
faction.get('/storage', (c) => {
  const station = c.req.query('station') || undefined
  const rows = getFactionStorage(station)
  const byStation: Record<string, { updated_at: string; reported_by: string | null; items: Array<{ item_id: string; item_name: string; quantity: number }> }> = {}
  for (const r of rows) {
    const s = byStation[r.station_id] ??= { updated_at: r.updated_at, reported_by: r.reported_by, items: [] }
    if (r.updated_at > s.updated_at) { s.updated_at = r.updated_at; s.reported_by = r.reported_by }
    s.items.push({ item_id: r.item_id, item_name: r.item_name, quantity: r.quantity })
  }
  return c.json({ stations: byStation })
})

/** Booked treasury and lockbox movements. ?since=ISO&kind=&item=&profile=&limit= */
faction.get('/ledger', (c) => {
  const q = c.req.query()
  return c.json(getFactionLedger({ since: q.since, kind: q.kind, itemId: q.item, profileId: q.profile, limit: q.limit ? Number(q.limit) : undefined }))
})

/** Treasury reconciliation: last reported balance vs booked movements. */
faction.get('/treasury', (c) => c.json(getFactionTreasurySummary()))

export default faction
