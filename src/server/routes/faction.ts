import { Hono } from 'hono'
import { agentManager } from '../lib/agent-manager'
import { listProfiles, getDb, getFactionStorage, getFactionLedger, getFactionTreasurySummary, getFactionTreasuryStatement, getStorageForProfile, getStorageElsewhere } from '../lib/db'
import { getFacility, getShip } from '../lib/catalog'
import { computeShipBuild, parseCargoItems } from '../lib/ship-build'

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

/** Facility rent: every facility the fleet pays for, its per-cycle rate and day cost.
 *
 *  Rent is the treasury's largest standing outflow and the game never reports it as a
 *  command result — it is auto-deducted every facility cycle from the owner's wallet
 *  (the faction treasury for faction facilities) wherever the owner is. The per-facility
 *  rate is stated in `facility action=list` and captured into fleet_intel_facilities;
 *  CYCLES_PER_DAY comes from the game's own est_rent_per_day / rent_per_cycle = 86. */
faction.get('/rent', (c) => {
  const CYCLES_PER_DAY = 86
  const rows = getDb().query(`
    SELECT station_id, facility_type, facility_name, level, rent_per_cycle, faction_owned,
           build_cost, last_seen
      FROM fleet_intel_facilities
     WHERE rent_per_cycle IS NOT NULL AND rent_per_cycle > 0
     ORDER BY rent_per_cycle DESC`).all() as Array<Record<string, unknown>>
  const facilities = rows.map(r => ({
    ...r,
    per_day: Math.round(Number(r.rent_per_cycle) * CYCLES_PER_DAY),
  }))
  const perCycle = facilities.reduce((s, f) => s + Number(f.rent_per_cycle), 0)
  return c.json({
    cycles_per_day: CYCLES_PER_DAY,
    cycle_minutes: Math.round((24 * 60 / CYCLES_PER_DAY) * 10) / 10,
    facilities,
    totals: { per_cycle: perCycle, per_day: Math.round(perCycle * CYCLES_PER_DAY) },
    note: 'Rates are what the game stated the last time an agent docked at that station. '
        + 'A facility we own at a station nobody has visited recently will be missing here.',
  })
})

/** Full treasury statement: every credit in and out with a reason, including the
 *  unattributed deltas that facility rent hides in (rent is never reported as a
 *  command result, so a command-only ledger loses the biggest recurring outflow).
 *  ?since=ISO&limit=  */
faction.get('/treasury/statement', (c) => {
  const q = c.req.query()
  return c.json(getFactionTreasuryStatement({
    since: q.since, limit: q.limit ? Number(q.limit) : undefined,
    facilityCost: (type) => getFacility(type)?.build_cost ?? null,
  }))
})

/**
 * GET /api/faction/build-queue — the facility programme as an ordered queue.
 *
 * Two things make this different from the vault page's flat "build need" column,
 * which sums `commission_requirements` and reports one number per item:
 *
 *  1. **It gates on the FACTION VAULT, not fleet-wide stock.** `facility action=
 *     faction_build` draws from faction storage at the station, then the builder's
 *     cargo — it never sees a personal locker. On 2026-09-16 a fleet-wide count read
 *     436 control_node when only 202 were buildable, which would have announced an
 *     open gate 48 short.
 *  2. **The queue is SEQUENTIAL.** Building the first facility consumes its 250
 *     control_node, so the second cannot also count them. Each entry is measured
 *     against what is left after the entries above it take their share — which is
 *     what makes this a queue rather than four independent checklists.
 *
 * `pct` is the BINDING ratio (the worst material), because a build is gated by its
 * scarcest input, not its average. A facility 100% on steel and 10% on nodes is 10%
 * done, not 55%.
 */
const FACILITY_QUEUE = [
  'plasma_injector_assembly',
  'plasma_residue_condenser',
  'tritium_cryo_extractor',
  // The polonium cell was missing from this list for the whole campaign, and its
  // absence hid the fact that the programme could not reach its own goal. The
  // chain is: breeder (owned) -> reactor_grade_plutonium -> polonium_doping_cell
  // -> weapons_grade_plutonium -> compression chamber -> neutronium_ingot. Build
  // the chamber without this and it stands idle: weapons_grade_plutonium has NO
  // ask in any empire, so it cannot be bought, only made here.
  // It also needs polonium_ore, which is rad-extracted — a mining laser pulls
  // none, so someone needs a rad_harvester FITTED, not merely owned.
  'polonium_doping_cell',
  'neutronium_compression_chamber',
  'fuel_rod_press',
] as const

faction.get('/build-queue', async (c) => {
  const station = c.req.query('station') || 'crimson_war_citadel'
  const vault = new Map<string, number>()
  for (const r of getFactionStorage(station)) vault.set(r.item_id, (vault.get(r.item_id) ?? 0) + Number(r.quantity))

  const treasury = getFactionTreasurySummary().latest?.credits ?? 0
  let creditsLeft = treasury
  const remaining = new Map(vault)   // walked down as each facility takes its share

  // A facility we ALREADY OWN must not appear as pending, and must not reserve
  // materials from the entries behind it — it already consumed its bill when it
  // was built. Before this, the moment plasma_injector_assembly was built the
  // queue still showed it "next up, 4.9%, blocked on steel_plate" against steel
  // that had just been spent ON it, while also holding 2,850 steel hostage from
  // the facility actually next in line.
  await refreshBuilt()
  const owned = new Set((builtCache?.rows ?? []).map(r => String((r as { type?: string }).type ?? '')))

  const queue = FACILITY_QUEUE.map((id, i) => {
    const f = getFacility(id)
    if (!f) return { id, name: id, order: i + 1, missing_from_catalog: true }
    const bill = (f.build_materials ?? []) as Array<{ item_id: string; quantity: number }>

    // Already standing: report it as done and take nothing from the vault.
    if (owned.has(id)) {
      return {
        id, name: f.name ?? id, order: i + 1,
        build_cost: f.build_cost ?? 0, build_time: f.build_time ?? null,
        credits_ok: true, materials: [], pct: 1,
        buildable: false, built: true, binding: null, short_count: 0,
      }
    }

    const materials = bill.map(m => {
      const have = remaining.get(m.item_id) ?? 0
      const applied = Math.min(have, m.quantity)
      return {
        item_id: m.item_id,
        needed: m.quantity,
        available: have,
        short: Math.max(0, m.quantity - have),
        pct: m.quantity > 0 ? Math.min(1, have / m.quantity) : 1,
      }
    })

    // Reserve this facility's share so later entries see only the remainder.
    for (const m of bill) remaining.set(m.item_id, Math.max(0, (remaining.get(m.item_id) ?? 0) - m.quantity))

    const cost = f.build_cost ?? 0
    const creditsOk = creditsLeft >= cost
    if (creditsOk) creditsLeft -= cost

    const pct = materials.length ? Math.min(...materials.map(m => m.pct)) : 1
    const shortLines = materials.filter(m => m.short > 0)
    return {
      id, name: f.name ?? id, order: i + 1,
      build_cost: cost, build_time: f.build_time ?? null,
      credits_ok: creditsOk,
      materials,
      pct,
      buildable: shortLines.length === 0 && creditsOk,
      built: false,
      // The single line to fix next — what a reader should act on.
      binding: shortLines.sort((a, b) => a.pct - b.pct)[0]?.item_id ?? null,
      short_count: shortLines.length,
    }
  })

  return c.json({ station, treasury, queue, built: builtCache?.rows ?? [] })
})

/**
 * What the faction already owns — the "done" end of the build queue.
 *
 * Read LIVE through a connected agent rather than from `fleet_intel_facilities`.
 * That table is passively scraped from whatever agents happened to report, and on
 * 2026-09-16 it held two faction facilities at 338/cycle when the game returned
 * FOUR at 708/cycle — including a lockbox at Iron Reach nobody knew we had. A
 * completed-builds list sourced from it would have been wrong about the one thing
 * it exists to show.
 *
 * `facility action=faction_owned` works UNDOCKED, so this does not depend on who
 * is flying. Cached 60s because the UI polls every 30s and the list changes rarely.
 */
let builtCache: { at: number; rows: unknown[] } | null = null

async function refreshBuilt(): Promise<void> {
  if (builtCache && Date.now() - builtCache.at < 60_000) return
  const agentId = pickAgent()
  if (!agentId) return
  try {
    const raw = await runQuery(agentId, 'facility', { action: 'faction_owned' })
    const res = (raw.structuredContent ?? raw.result) as Record<string, unknown> | undefined
    const list = Array.isArray(res?.facilities) ? res!.facilities as Array<Record<string, unknown>> : []
    // first_seen is OUR earliest record of the facility, not the game's build date —
    // the game does not report one. Label it honestly in the UI.
    const seen = new Map<string, string>()
    try {
      for (const r of getDb().query(
        'SELECT station_id, facility_type, MIN(first_seen) AS first_seen FROM fleet_intel_facilities GROUP BY station_id, facility_type'
      ).all() as Array<{ station_id: string; facility_type: string; first_seen: string }>) {
        seen.set(`${r.station_id}|${r.facility_type}`, r.first_seen)
      }
    } catch { /* intel table may be empty */ }

    const rows = list.map(f => ({
      facility_id: String(f.facility_id ?? ''),
      type: String(f.type ?? ''),
      name: String(f.name ?? f.type ?? ''),
      station_id: String(f.base_id ?? ''),
      station_name: String(f.base_name ?? f.base_id ?? ''),
      system_id: String(f.system_id ?? ''),
      rent_per_cycle: Number(f.rent_per_cycle ?? 0),
      labor_per_run: Number(f.labor_per_run ?? 0),
      under_construction: !!f.under_construction,
      first_seen: seen.get(`${String(f.base_id ?? '')}|${String(f.type ?? '')}`) ?? null,
    }))
    // Anything still building first (it is the live edge), then newest known first.
    rows.sort((a, b) => Number(b.under_construction) - Number(a.under_construction)
      || String(b.first_seen ?? '').localeCompare(String(a.first_seen ?? '')))
    builtCache = { at: Date.now(), rows }
  } catch { /* keep the last good list */ }
}

/** Kick the live refresh alongside the queue read so the UI gets both from one poll. */
faction.get('/build-queue/built', async (c) => {
  await refreshBuilt()
  return c.json({ built: builtCache?.rows ?? [], cached_at: builtCache?.at ?? null })
})

/**
 * GET /api/faction/ship-build — the SHIP commission bill, gated on what the
 * commission can actually reach.
 *
 * Deliberately NOT the same shape as /build-queue, because the two consumers read
 * OPPOSITE places (plan §30, verified against the guides):
 *
 *   facility_build     -> packages, FACTION STORAGE at the station, then cargo.
 *                         Never a personal locker.
 *   supply_commission  -> the pilot's CARGO, then the pilot's PERSONAL locker.
 *                         Never faction storage — that applies only at a station
 *                         the faction owns, and we own none.
 *
 * So a part sitting in the faction vault is invisible to the yard even though it
 * is in the same station. The accounting lives in lib/ship-build.ts so it can be
 * tested without a catalog or an HTTP round trip.
 */
faction.get('/ship-build', (c) => {
  const shipId = c.req.query('ship') || 'crimson_devastator'
  const station = c.req.query('station') || 'crimson_war_citadel'
  const pilotHint = c.req.query('pilot') || "Morg'Thar"

  const ship = getShip(shipId)
  if (!ship) return c.json({ error: `ship ${shipId} not in catalog` }, 404)

  const pilot = listProfiles().find(p => p.name?.toLowerCase().includes(pilotHint.toLowerCase().split("'")[0]))
  if (!pilot) return c.json({ error: `no profile matching pilot ${pilotHint}` }, 404)

  // Cargo comes from the live agent state, not the DB: storage_inventory tracks
  // station lockers and never the hold.
  const st = agentManager.getStatus(pilot.id) as { gameState?: { ship?: { cargoItems?: unknown[] } } } | undefined
  const cargo = parseCargoItems(st?.gameState?.ship?.cargoItems ?? [])

  const locker = new Map<string, number>()
  for (const r of getStorageForProfile(pilot.id, station)) {
    const q = Number((r as { quantity?: number }).quantity ?? 0)
    if (q > 0) locker.set(String((r as { item_id?: string }).item_id ?? ''), q)
  }

  const vault = new Map<string, number>()
  for (const r of getFactionStorage(station)) vault.set(r.item_id, (vault.get(r.item_id) ?? 0) + Number(r.quantity))

  // The catalog's build_materials IS the bare hull. A commission_quote with no
  // arguments prices the DEFAULT LOADOUT instead — 24 lines for the Devastator
  // against the hull's 17 — and three of those seven extras have no seller in the
  // galaxy and would each need a 1.1-1.6M facility. Costing them as part of the
  // ship invented a 3.94M wall that does not exist (plan §43).
  const bill = (ship.build_materials ?? []) as Array<{ item_id: string; quantity: number }>
  const result = computeShipBuild({
    bill, cargo, locker, vault,
    elsewhereFor: (itemId) => getStorageElsewhere(station, itemId).reduce((sum, r) => sum + Number(r.quantity), 0),
  })

  return c.json({
    ship: shipId,
    ship_name: ship.name ?? shipId,
    station, pilot: pilot.name, pilot_id: pilot.id,
    bare_hull: true,
    shipyard_tier_required: ship.shipyard_tier ?? null,
    build_time: ship.build_time ?? null,
    treasury: getFactionTreasurySummary().latest?.credits ?? 0,
    ...result,
  })
})

export default faction
