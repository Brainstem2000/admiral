import { Hono } from 'hono'
import { agentManager } from '../lib/agent-manager'
import { listProfiles, getDb, getFactionStorage, getFactionLedger, getVaultMovements, getFactionTreasurySummary, getFactionTreasuryStatement, getStorageForProfile, getStorageElsewhere, getPreference} from '../lib/db'
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

// The faction's home station — the one the Build Here page is about.
const HOME_STATION = 'crimson_war_citadel'

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
/** Where an agent is DOCKED right now, or null if it is in space. `facility action='list'`
 *  and every other station-scoped query answer for THIS station and no other, so a caller
 *  that needs one station's data must pick an agent standing in it. */
function dockedAt(profileId: string): string | null {
  const conn = (agentManager.getAgent(profileId) as unknown as
    { connection?: { getLocalState?: () => { location?: { docked_at?: string | null } } | null } } | null)?.connection
  return conn?.getLocalState?.()?.location?.docked_at ?? null
}

/**
 * An agent DOCKED AT `stationId`, or null. Needed because `facility action='list'` reports
 * the station the agent is standing in and says so only in its `base_id` — so the Build Here
 * page's "Under construction — live from the station" panel showed whatever station the
 * picked agent happened to be at. On 2026-09-18 that was Central Nexus's 8,829,000cr
 * Singularity Charge Foundry, rendered as if it were ours at War Citadel, because the leader
 * (CyberSpock) had just been connected while docked there.
 */
function pickAgentDockedAt(stationId: string): string | null {
  for (const p of listProfiles()) {
    if (!agentManager.getAgent(p.id)?.isConnected) continue
    if (dockedAt(p.id) === stationId) return p.id
  }
  return null
}

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

/**
 * The faction vault as an item ledger: every deposit and withdrawal, who moved it, and
 * what the vault held afterwards — plus the rollups an accountant asks for first.
 *
 * The neighbouring `/ledger` route returns the raw table, and the vault page's "ledger"
 * tab has always rendered the TREASURY statement, which is credits only. So "what went
 * into the vault, how much, and who put it there" had no answer in the UI even though
 * every row needed to answer it was already being written. This is that answer.
 *
 * `?station=&item=&profile=&since=&limit=` all narrow it. Rollups are computed over the
 * rows actually returned, so a narrowed query rolls up the narrowed set — and `truncated`
 * says when the limit clipped the window, because a total over a clipped window is a
 * partial total and must never be presented as a complete one.
 */
faction.get('/vault-ledger', (c) => {
  const q = c.req.query()
  const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 500, 1), 5000) : 500
  const movements = getVaultMovements({
    station: q.station, itemId: q.item, profileId: q.profile, since: q.since, limit,
  })

  const byItem = new Map<string, { item_id: string; in: number; out: number; net: number; moves: number; last: string }>()
  const byAgent = new Map<string, { agent: string; in: number; out: number; net: number; moves: number; last: string }>()
  for (const m of movements) {
    const i = byItem.get(m.item_id) ?? { item_id: m.item_id, in: 0, out: 0, net: 0, moves: 0, last: m.timestamp }
    const a = byAgent.get(m.agent) ?? { agent: m.agent, in: 0, out: 0, net: 0, moves: 0, last: m.timestamp }
    for (const r of [i, a]) {
      if (m.delta >= 0) r.in += m.delta; else r.out += -m.delta
      r.net += m.delta; r.moves += 1
      if (m.timestamp > r.last) r.last = m.timestamp
    }
    byItem.set(m.item_id, i); byAgent.set(m.agent, a)
  }
  const desc = <T extends { net: number }>(rows: T[]) => rows.sort((x, y) => Math.abs(y.net) - Math.abs(x.net))

  // RECONCILIATION — the part that makes this an accounting system rather than a log.
  //
  // The ledger is built from OUR agents' command results, so it can only ever explain
  // what the harness drove. Faction members outside Admiral — UMan, hand-played, who is
  // the faction's Quartermaster — deposit into the same vault and leave no row, because
  // Admiral never sees their command responses and the game exposes no faction-level
  // transaction log to read instead. Brian asked why UMan's deposits do not show up; this
  // is the answer, stated in the data rather than left as a silent hole.
  //
  // Method: every movement the game answered with a running total carries `balance_after`.
  // Take the newest such checkpoint per item, add the booked deltas that came after it, and
  // compare to what the vault actually holds now. A non-zero difference is stock that moved
  // without a booked command — almost always a member we do not drive.
  //
  // Items with no checkpoint are reported as `unknown`, never as zero: an unverifiable line
  // presented as reconciled is worse than one marked unverifiable.
  const station = q.station || 'crimson_war_citadel'
  const held = new Map<string, number>()
  for (const r of getFactionStorage(station)) held.set(r.item_id, Number(r.quantity) || 0)

  // Checkpoints and "movements since" are both keyed on TIME, not on id. Audit-log rows
  // carry the game's own historical stamps, so a higher id no longer means "later" — using
  // id here would count a just-discovered old transfer as having happened after a newer one.
  const checkpoint = new Map<string, { balance: number; at: string; id: number }>()
  for (const m of movements) {                       // newest first
    if (m.balance_after === null || m.station_id !== station) continue
    if (!checkpoint.has(m.item_id)) checkpoint.set(m.item_id, { balance: m.balance_after, at: m.timestamp, id: m.id })
  }
  const unexplained: Array<{ item_id: string; expected: number; actual: number; difference: number }> = []
  let unknownItems = 0
  for (const [itemId, actual] of held) {
    const cp = checkpoint.get(itemId)
    if (!cp) { if (actual > 0) unknownItems += 1; continue }
    const since = movements
      .filter(m => m.item_id === itemId && m.station_id === station
        && (m.timestamp > cp.at || (m.timestamp === cp.at && m.id > cp.id)))
      .reduce((n, m) => n + m.delta, 0)
    const expected = cp.balance + since
    if (expected !== actual) unexplained.push({ item_id: itemId, expected, actual, difference: actual - expected })
  }
  unexplained.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))

  return c.json({
    movements,
    by_item: desc([...byItem.values()]),
    by_agent: desc([...byAgent.values()]),
    reconciliation: {
      station,
      unexplained,
      unexplained_total: unexplained.reduce((n, r) => n + r.difference, 0),
      items_without_checkpoint: unknownItems,
      note: 'Stock the books cannot explain, and there are two distinct causes — do not read '
        + 'it as one. POSITIVE: a deposit Admiral never saw, which is usually a faction member '
        + 'played outside the harness (UMan is Quartermaster and hand-driven), since the game '
        + 'exposes no faction transaction log to read instead. NEGATIVE: vault stock consumed '
        + 'without a withdrawal command — craft(source="faction") draws its inputs straight out '
        + 'of the vault and books nothing, which is why gold_wiring, weapon_core and '
        + 'platinum_wiring all show short here. Both are real movements; neither is an error.',
    },
    totals: {
      deposited: movements.reduce((n, m) => n + (m.delta > 0 ? m.delta : 0), 0),
      withdrawn: movements.reduce((n, m) => n + (m.delta < 0 ? -m.delta : 0), 0),
      net: movements.reduce((n, m) => n + m.delta, 0),
      movements: movements.length,
      items: byItem.size,
      agents: byAgent.size,
      first: movements.length ? movements[movements.length - 1].timestamp : null,
      last: movements.length ? movements[0].timestamp : null,
    },
    truncated: movements.length >= limit,
  })
})

/**
 * EVERYTHING WE STILL NEED, in one list.
 *
 * The data existed in three places and nothing joined them: `/build-queue` knows what each
 * facility is short of, `/ship-build` knows the Devastator's lines, and the vault knows what
 * we hold. So the question an operator actually asks — "what is this fleet still missing,
 * across every open build?" — had no answer without reading three pages and doing the
 * arithmetic by hand. Brian asked for exactly that view.
 *
 * Merges facility builds and the ship build, aggregates by ITEM, and reports for each:
 * how much every open build wants in total, what we hold and where, and the net shortfall.
 *
 * Two things it deliberately does NOT do:
 *  - It does not net a shortfall against stock at another station without saying so. Vault
 *    material elsewhere is ours and withdrawable, but it is a retrieval run away, and
 *    collapsing that distinction is how 3,346 steel_plate stayed invisible across four
 *    vaults while a facility sat 102 short.
 *  - It does not resolve a shortfall into its craft inputs. That is a different question
 *    with a different answer per recipe, and guessing at it here would produce a number
 *    that looks authoritative and is not.
 */
faction.get('/needed', async (c) => {
  const station = c.req.query('station') || 'crimson_war_citadel'

  interface Want { item_id: string; needed: number; wanted_by: string[] }
  const wants = new Map<string, Want>()
  const add = (itemId: string, qty: number, by: string) => {
    if (!itemId || !(qty > 0)) return
    const w = wants.get(itemId) ?? { item_id: itemId, needed: 0, wanted_by: [] }
    w.needed += qty
    if (!w.wanted_by.includes(by)) w.wanted_by.push(by)
    wants.set(itemId, w)
  }

  // Populate the built-facility cache BEFORE reading it. It is filled lazily by whichever
  // route asks first, so a fresh server answering /needed saw an empty cache and counted
  // every facility as still-to-build — including the four we already own, which inflated
  // steel_plate demand by thousands. Never read a lazily-filled cache without filling it.
  await refreshBuilt()

  const builds: Array<{ kind: string; name: string; status: string; short_lines: number }> = []

  // 1) Facilities still to build, from the runtime queue.
  for (const id of facilityQueue()) {
    const f = getFacility(id)
    if (!f) continue
    const mats = (f.build_materials ?? []) as Array<{ item_id: string; quantity: number }>
    if (!mats.length) continue
    // Already standing? Skip it. `builtCache` is the same 60s-cached `facility
    // faction_owned` read the build queue uses, so the two pages cannot disagree
    // about what exists — the bug that made a built facility keep asking for
    // materials until someone noticed.
    const owned = new Set((builtCache?.rows ?? []).map(r => String((r as { type?: string }).type ?? '')))
    if (owned.has(id)) continue
    for (const m of mats) add(String(m.item_id), Number(m.quantity) || 0, f.name ?? id)
    builds.push({ kind: 'facility', name: f.name ?? id, status: 'planned', short_lines: mats.length })
  }

  // 2) The ship build — its bill is the BARE HULL, not the default loadout (plan §43).
  const ship = getShip('crimson_devastator')
  if (ship) {
    const bill = (ship.build_materials ?? []) as Array<{ item_id: string; quantity: number }>
    for (const m of bill) add(String(m.item_id), Number(m.quantity) || 0, ship.name ?? 'Crimson Devastator')
    builds.push({ kind: 'ship', name: ship.name ?? 'Crimson Devastator', status: 'staging', short_lines: bill.length })
  }

  // What we hold, by location class.
  const vault = new Map<string, number>()
  for (const r of getFactionStorage(station)) vault.set(r.item_id, (vault.get(r.item_id) ?? 0) + Number(r.quantity))
  const otherVault = new Map<string, number>()
  for (const r of getFactionStorage()) {
    if (r.station_id === station) continue
    otherVault.set(r.item_id, (otherVault.get(r.item_id) ?? 0) + Number(r.quantity))
  }
  const lockers = new Map<string, number>()
  for (const r of getDb().query(
    `SELECT item_id, SUM(quantity) q FROM storage_inventory
      WHERE quantity > 0 AND station_id IS NOT NULL GROUP BY item_id`).all() as Array<{ item_id: string; q: number }>) {
    lockers.set(r.item_id, Number(r.q) || 0)
  }

  const items = [...wants.values()].map(w => {
    const v = vault.get(w.item_id) ?? 0
    const ov = otherVault.get(w.item_id) ?? 0
    const lk = lockers.get(w.item_id) ?? 0
    const short = Math.max(0, w.needed - v)
    return {
      ...w,
      vault: v, other_vaults: ov, lockers: lk,
      short,                                   // against THIS station's vault only
      short_after_retrieval: Math.max(0, w.needed - v - ov - lk),
      status: short === 0 ? 'covered' : (short <= ov + lk ? 'retrievable' : 'must_source'),
    }
  }).sort((a, b) => (b.short - a.short) || b.needed - a.needed)

  return c.json({
    station, builds, items,
    totals: {
      items: items.length,
      covered: items.filter(i => i.status === 'covered').length,
      retrievable: items.filter(i => i.status === 'retrievable').length,
      must_source: items.filter(i => i.status === 'must_source').length,
      units_short: items.reduce((n, i) => n + i.short, 0),
      units_short_after_retrieval: items.reduce((n, i) => n + i.short_after_retrieval, 0),
    },
  })
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
           build_cost, last_seen, recipe_id, access, rental_fee_per_run, labor_per_run
      FROM fleet_intel_facilities
     WHERE rent_per_cycle IS NOT NULL AND rent_per_cycle > 0
     ORDER BY rent_per_cycle DESC`).all() as Array<Record<string, unknown>>
  const facilities = rows.map(r => ({
    ...r,
    per_day: Math.round(Number(r.rent_per_cycle) * CYCLES_PER_DAY),
    // What it MAKES and whether it EARNS. A roster of names cannot answer "do we own
    // something that makes X" — on 2026-09-18 the Plasma Injector Assembly sat in this
    // table with a NULL recipe while the injector line was called unbuildable.
    // `access` is NULL until the game states it; NULL is UNKNOWN, never "public".
    makes: String(r.recipe_id ?? '').split(',').filter(Boolean),
    net_per_run: r.rental_fee_per_run == null ? null
      : Math.round((Number(r.rental_fee_per_run) - Number(r.labor_per_run ?? 0)) * 100) / 100,
  }))
  const perCycle = facilities.reduce((s, f) => s + Number(f.rent_per_cycle), 0)
  return c.json({
    cycles_per_day: CYCLES_PER_DAY,
    cycle_minutes: Math.round((24 * 60 / CYCLES_PER_DAY) * 10) / 10,
    facilities,
    totals: { per_cycle: perCycle, per_day: Math.round(perCycle * CYCLES_PER_DAY) },
    note: 'Rates are what the game stated the last time an agent docked at that station. '
        + 'A facility we own at a station nobody has visited recently will be missing here. '
        + 'Access shows UNKNOWN until the game states it — the column used to default to '
        + 'public, which is why the Plasma Injector Assembly read as rentable while it was private.',
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
const DEFAULT_FACILITY_QUEUE = [
  'plasma_injector_assembly',
  'plasma_residue_condenser',
  'tritium_cryo_extractor',
  // Added 2026-09-17. This list is the ONLY thing the build page renders, so a
  // facility the fleet is actively assembling is invisible until it appears here —
  // Brian asked where the Tungsten Drawing Frame was and the answer was "nowhere",
  // while three agents were buying, forging and hauling its materials. If you decide
  // to build something, put it in this list in the same change.
  //
  // It sits ahead of the chamber because it is the nearer win: 102,000cr against
  // 314,000, its materials are ~90% assembled, and it unblocks the Devastator's
  // LARGEST open line — weapon_core, 218 short — out of 7,340 tungsten_ore the fleet
  // already owns and had written off as dead weight. draw_tungsten_rod is the one
  // rung of build_weapon_core that is not hand-craftable.
  'tungsten_drawing_frame',
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

/**
 * The build page renders this list and nothing else, so a facility missing from it is
 * invisible while the fleet works on it — that is exactly what happened to the Tungsten
 * Drawing Frame on 2026-09-17, with three agents buying, forging and hauling its
 * materials and Brian finding no trace of it on any page.
 *
 * A hardcoded array makes "remember to edit the source" the only safeguard, which is a
 * process, not a fix. The order is now stored under the `facility_build_queue`
 * preference as a JSON array of facility ids and can be changed at runtime; the constant
 * above is the fallback when nothing is stored or the stored value is unusable.
 */
function facilityQueue(): string[] {
  const raw = getPreference('facility_build_queue')
  if (!raw) return [...DEFAULT_FACILITY_QUEUE]
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length && parsed.every(x => typeof x === 'string' && x))
      return parsed as string[]
  } catch { /* stored value is junk — fall through to the default rather than 500 */ }
  return [...DEFAULT_FACILITY_QUEUE]
}

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
  await refreshStation()
  const owned = new Set((builtCache?.rows ?? []).map(r => String((r as { type?: string }).type ?? '')))

  const queue = facilityQueue().map((id, i) => {
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

  return c.json({
    station, treasury, queue,
    built: builtCache?.rows ?? [],
    // What the GAME says is actually being built here, with real per-material gaps.
    // `under_construction_station` is the station this answer is FOR — the panel must
    // name it rather than say "the station" and let the reader assume it is ours.
    under_construction: stationCache?.pending ?? [],
    under_construction_station: stationCache?.station_id ?? null,
    // Cheapest public venue per recipe — rent before you build.
    rentable: stationCache?.rentable ?? [],
  })
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
/**
 * The build page used to render ONLY the curated FACILITY_QUEUE, so anything the fleet was
 * actually building was invisible unless somebody had remembered to add it. That failed twice
 * on 2026-09-17: first the Tungsten Drawing Frame, then a Railgun Capacitor Assembly Line
 * already standing at `waiting_for_materials` that nobody could find on any page.
 *
 * `facility` `{action:"list"}` is a FREE query and the game answers it with the truth:
 * `construction.pending` (what is really being built, with per-material shortfalls) and the
 * public facilities at the station with their rental fees. Both now reach the UI, so the page
 * shows reality first and our wishlist second.
 */
let stationCache: { at: number; station_id: string; pending: unknown[]; rentable: unknown[] } | null = null

async function refreshStation(): Promise<void> {
  if (stationCache && Date.now() - stationCache.at < 60_000) return
  // MUST be an agent docked at the home station: this answer is per-station and the panel
  // is labelled as ours. No docked agent means no panel — never another station's queue.
  const agentId = pickAgentDockedAt(HOME_STATION)
  if (!agentId) return
  try {
    const raw = await runQuery(agentId, 'facility', { action: 'list' })
    const res = (raw.structuredContent ?? raw.result) as Record<string, unknown> | undefined
    if (!res) return
    // Trust the answer's own base_id over where we thought the agent was.
    const reported = String(res.base_id ?? '')
    if (reported && reported !== HOME_STATION) return
    const construction = (res.construction ?? {}) as Record<string, unknown>
    const pending = (Array.isArray(construction.pending) ? construction.pending : []) as Array<Record<string, unknown>>

    // Public production venues, cheapest fee first. This is the half that stops us building
    // what is already standing idle fifty metres away — 14 public Tungsten Drawing Frames at
    // 32/run against a 102,000cr build.
    const rentable: Array<Record<string, unknown>> = []
    for (const key of ['station_facilities', 'public_facilities']) {
      for (const f of (Array.isArray(res[key]) ? res[key] : []) as Array<Record<string, unknown>>) {
        const prod = (f.production ?? {}) as Record<string, unknown>
        if (!prod.public || !f.recipe_id) continue
        rentable.push({
          type: String(f.type ?? ''), name: String(f.name ?? f.type ?? ''),
          recipe_id: String(f.recipe_id ?? ''),
          fee_per_run: Number(prod.rental_fee_per_run ?? 0),
          items_per_hour: Number(prod.items_per_hour ?? 0),
          backlog_ticks: Number(prod.backlog_ticks ?? 0),
          owner: key === 'public_facilities' ? 'player' : 'station',
        })
      }
    }
    // One row per recipe: the cheapest venue that can run it.
    const byRecipe = new Map<string, Record<string, unknown>>()
    for (const r of rentable) {
      const k = String(r.recipe_id)
      const cur = byRecipe.get(k)
      if (!cur || Number(r.fee_per_run) < Number(cur.fee_per_run)) byRecipe.set(k, { ...r, copies: 0 })
    }
    for (const r of rentable) {
      const row = byRecipe.get(String(r.recipe_id))
      if (row) row.copies = Number(row.copies ?? 0) + 1
    }
    stationCache = { at: Date.now(), station_id: reported || HOME_STATION, pending, rentable: [...byRecipe.values()] }
  } catch { /* a live read failing must never take the page down */ }
}

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
    // The faction holds stock at SEVEN stations and every one is withdrawable,
    // but only crimson_war_citadel accepts deposits. Material in another vault is
    // OURS and one retrieval run away — counting it as merely "elsewhere" hid
    // 3,346 steel_plate spread across four vaults while facility #4 sat 102 short.
    otherVaultsFor: (itemId) => getFactionStorage()
      .filter(r => r.station_id !== station && r.item_id === itemId)
      .reduce((sum, r) => sum + Number(r.quantity), 0),
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
