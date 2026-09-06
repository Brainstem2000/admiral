import { Hono } from 'hono'
import { agentManager } from '../lib/agent-manager'
import { listProfiles, getDb } from '../lib/db'

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

function pickAgent(): string | null {
  const profiles = listProfiles()
  const connected = profiles.filter((p) => agentManager.getAgent(p.id)?.isConnected)
  if (connected.length === 0) return null
  const leader = connected.find((p) => p.name.includes(LEADER_NAME_HINT))
  return (leader ?? connected[0]).id
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

    const homeRaw = await runQuery(agentId, 'view_faction_storage').catch((e) => ({ error: { message: String(e) } }))
    // The hint (on success or error) names every station with faction goods:
    // "22,086 items in faction storage at a, b, c". Harvest it either way.
    const homeText = JSON.stringify(homeRaw)
    const hintMatch = homeText.match(/([\d,]+) items in faction storage at ([a-z0-9_,\s]+)/i)
    let hintedStations: string[] = []
    let hintedTotal: number | null = null
    if (hintMatch) {
      hintedTotal = Number(hintMatch[1].replace(/,/g, ''))
      hintedStations = hintMatch[2].split(',').map((s) => s.trim()).filter(Boolean)
      aggregateNote = `${hintMatch[1]} items ledgered across ${hintedStations.length} stations`
    }
    parseVault(homeRaw as Record<string, unknown>, 'current_station')

    for (const sid of hintedStations) {
      if (stations.has(sid)) continue
      const raw = await runQuery(agentId, 'view_faction_storage', { station_id: sid })
        .catch((e) => ({ error: { message: String(e) } }))
      parseVault(raw as Record<string, unknown>, sid)
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

export default faction
