import { getDb, gameTimestamp, markAllRentLapsed, markObligationLapsed, listActiveObligations } from './db'
import { getFacility } from './catalog'
import { safeTruncate } from './text-safe'
import { feedSaysSystemHasStation, feedServicesForSystem, systemForBase } from './stations-feed'
import type { FleetIntelData, MarketIntel, SystemIntel, ThreatIntel, KillZone, PlayerSighting } from '../../shared/fleet-intel-types'

type R = Record<string, unknown>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null }
function int(v: unknown): number { return typeof v === 'number' ? Math.floor(v) : 0 }

/** Refutations repeat on every turn of a looping agent; say each one once per process. */
const loggedOnce = new Set<string>()
function logOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return
  loggedOnce.add(key)
  console.warn(message)
}

/**
 * Does this POI carry a dockable base? get_system's SystemPOI says so with `has_base`
 * (plus base_id/base_name); older/other shapes only hint through the type string.
 */
function poiHasBase(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false
  const poi = p as R
  if (poi.has_base === true || poi.has_station === true) return true
  if (poi.has_base === false) return false
  if (str(poi.base_id)) return true
  const t = str(poi.type).toLowerCase()
  return t.includes('station') || t.includes('outpost') || t === 'base'
}

/**
 * Quantity resting at the best price in a raw order book.
 *
 * Bids are best-high, asks best-low. Several orders can sit at the same price, so they
 * are summed. Returns null when the book is absent or unparseable (unknown), and 0 for a
 * book that is present and empty (genuinely nothing bid) -- callers rely on that split.
 */
function qtyAtBest(orders: unknown, side: 'buy' | 'sell'): number | null {
  if (!Array.isArray(orders)) return null
  if (orders.length === 0) return 0
  let bestPrice: number | null = null
  let qty = 0
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue
    const ord = o as R
    const price = num(ord.price_each ?? ord.price ?? ord.unit_price)
    const q = num(ord.quantity ?? ord.qty ?? ord.amount)
    if (price === null || price <= 0 || q === null || q <= 0) continue
    if (bestPrice === null || (side === 'buy' ? price > bestPrice : price < bestPrice)) {
      bestPrice = price
      qty = q
    } else if (price === bestPrice) {
      qty += q
    }
  }
  return bestPrice === null ? null : qty
}

/**
 * Units available AT the best price on one side of a market listing.
 *
 * view_market reports it directly as `best_buy_qty` / `best_sell_qty`; the public feed at
 * game.spacemolt.com/api/market calls the same number `bid_quantity_at_best` /
 * `ask_quantity_at_best`. Where neither field is present the raw order book is walked.
 *
 * NOT `buy_quantity` / `bid_quantity`, which is the whole book summed across every price
 * level: enriched_uranium_rod at Iron Reach reported best_buy_qty 2 against buy_quantity
 * 38, because the second-best bid was already 122cr lower. Only the at-best figure bounds
 * what you get at the headline price, so only that one is stored.
 */
function bestQty(item: R, side: 'buy' | 'sell'): number | null {
  const direct = side === 'buy'
    ? item.best_buy_qty ?? item.bid_quantity_at_best
    : item.best_sell_qty ?? item.ask_quantity_at_best
  const n = num(direct)
  if (n !== null) return Math.max(0, Math.floor(n))
  return qtyAtBest(side === 'buy' ? item.buy_orders : item.sell_orders, side)
}

// Known ghost NPCs: permanently-present unkillable phantoms that read as "pirates" in
// get_nearby but never despawn and cannot be attacked (e.g. "Murmur Load" at
// ross_248_cryobelt). Sightings of ONLY these must not create/refresh kill zones.
const KNOWN_GHOSTS = [
  { name: 'murmur load', idPrefix: 'ab2c9a70' },
  // Permanent unkillable phantoms at 40 Eridani — same class as Murmur Load. Confirmed by the
  // fleet repeatedly "engaging" them with no result. Name-matched (their ids weren't captured).
  { name: 'clanker', idPrefix: '' },
  { name: 'glurch', idPrefix: '' },
]

function isGhostPirate(p: R): boolean {
  const name = str(p.name).toLowerCase()
  const id = str(p.pirate_id || p.id)
  return KNOWN_GHOSTS.some(g => name === g.name || (g.idPrefix && id.startsWith(g.idPrefix)))
}

export class FleetIntelCollector {
  /**
   * Extract and store intel from a game command result.
   * Called after every successful game command — must never throw.
   */
  static processCommandResult(command: string, result: unknown, reportedBy: string): void {
    if (!result || typeof result !== 'object') return
    const r = result as R

    // Dispatch on what the GAME says it did, falling back to a normalised command name.
    //
    // This switch used to match the raw command string exactly, which quietly missed
    // every prefixed form — v2 sends names like `spacemolt_market_view_market`, so
    // fleet_intel_market stayed empty through hundreds of successful view_market calls.
    // The response payload carries `action: view_market` regardless of how it was
    // addressed, so prefer that and keep the name as a fallback for payloads without it.
    const bare = command
      .replace(/^spacemolt_/, '')
      .replace(/^(market|ship|storage|social|nav|combat|faction|mission|crafting|player)_/, '')
    const key = str(r.action) || bare

    switch (key) {
      case 'view_market': return this.processMarket(r, reportedBy)
      // get_status and get_poi both carry `location.resources[]` — the per-POI deposit
      // table with richness, remaining and supported_power. get_status runs on nearly
      // every turn, so this is the richest intel stream the fleet has and it was going
      // straight to the floor.
      case 'get_status':
      case 'get_poi':
      case 'status': return this.processLocation(r, reportedBy)
      case 'get_system': return this.processSystem(r, reportedBy)
      case 'get_base': return this.processBase(r, reportedBy)
      case 'get_nearby': return this.processNearby(r, reportedBy)
      case 'scan': return this.processScan(r, reportedBy)
      case 'get_map': return this.processMap(r, reportedBy)
      case 'wrecks':
      case 'get_wrecks': return this.processWrecks(r, reportedBy)
      case 'list':
      case 'facility_list': return this.processFacilities(r, reportedBy)
      case 'owned':
      case 'facility_owned': return this.processOwnedFacilities(r, reportedBy)
    }
  }

  /**
   * RENTAL LAPSE. `facility_owned` (or `facility` + action:'owned') is the game's own
   * answer to "what do I still rent". An empty answer retires every rent obligation
   * on the register for that agent — and ONLY the game's answer does: Morg'Thar's
   * Lithium Cell Foundry row from 2026-08-06 was still being nagged about on
   * 2026-09-02 after the game had said `facilities: []` twice, because nothing
   * listened. Rows are never lapsed on age alone — wallet-zero agents accrue real
   * arrears in silence, and a stale row there is a debt, not a phantom.
   *
   * A later rent_paid event flips a lapsed row straight back to active
   * (recordObligations), so a wrong lapse costs at most one billing cycle of nag.
   */
  private static processOwnedFacilities(r: R, reportedBy: string): void {
    const rows = Array.isArray(r.facilities) ? r.facilities
      : Array.isArray(r.owned_facilities) ? r.owned_facilities
      : Array.isArray(r.player_facilities) ? r.player_facilities
      : null
    // Not a shape we understand — never lapse on ambiguity.
    if (!rows) return
    const db = getDb()
    const owner = db.query('SELECT id FROM profiles WHERE name = ?').get(reportedBy) as { id: string } | undefined
    if (!owner) return

    if (rows.length === 0) {
      const n = markAllRentLapsed(owner.id)
      if (n > 0) console.log(`[Intel] ${reportedBy} owns no facilities per the game — ${n} rent obligation(s) marked lapsed`)
      return
    }

    // The game enumerated what IS owned. Only stations it named are evidence: a rent
    // row at a station the answer covers, for a facility the answer omits, is gone.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    const ownedAt = new Map<string, Set<string>>()
    for (const f of rows as R[]) {
      if (!f || typeof f !== 'object') continue
      const base = str(f.base_id || f.station_id || '')
      if (!base) continue
      const set = ownedAt.get(base) ?? new Set<string>()
      for (const key of [f.type, f.facility_type, f.facility_id, f.id, f.name]) {
        const k = str(key)
        if (k) set.add(norm(k))
      }
      ownedAt.set(base, set)
    }
    for (const ob of listActiveObligations(owner.id)) {
      if (ob.obligation_type !== 'rent') continue
      const here = ownedAt.get(ob.station_id)
      if (!here || here.has(norm(ob.facility))) continue
      markObligationLapsed(owner.id, ob.facility, ob.station_id)
      console.log(`[Intel] ${reportedBy} no longer owns ${ob.facility} @${ob.station_id} per the game — rent obligation marked lapsed`)
    }
  }

  /** Record which crafting facilities exist at a station. `facility_list` is a free query
   *  and returns the station's whole roster; without this the fleet has no record of where
   *  anything can be crafted and rediscovers it by flying to the wrong place. */
  private static processFacilities(r: R, reportedBy: string): void {
    const stationId = str(r.base_id || r.station_id || '')
    if (!stationId) return
    const stationName = str(r.base_name || r.station_name || '')
    // player_facilities rows belong to the CALLING agent — that array membership is
    // the only ownership signal the payload carries.
    const groups: Array<{ rows: unknown; owned: boolean }> = [
      { rows: r.station_facilities, owned: false },
      { rows: r.facilities, owned: false },
      { rows: r.player_facilities, owned: true },
      { rows: r.faction_facilities, owned: false },
    ]
    if (!groups.some(g => Array.isArray(g.rows) && g.rows.length > 0)) return

    const db = getDb()
    // reportedBy is the profile display name (that is what every capture path passes);
    // resolve it to the id once so ownership rows reference profiles properly.
    const ownerId = (db.query('SELECT id FROM profiles WHERE name = ?').get(reportedBy) as { id: string } | undefined)?.id ?? null
    const q = db.query(`
      INSERT INTO fleet_intel_facilities
        (station_id, facility_type, facility_name, station_name, status, maintenance,
         owned, owner_profile_id, build_cost, reported_by, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station_id, facility_type) DO UPDATE SET
        facility_name = COALESCE(NULLIF(excluded.facility_name, ''), fleet_intel_facilities.facility_name),
        station_name  = COALESCE(NULLIF(excluded.station_name, ''),  fleet_intel_facilities.station_name),
        status        = COALESCE(NULLIF(excluded.status, ''),        fleet_intel_facilities.status),
        maintenance   = COALESCE(NULLIF(excluded.maintenance, ''),   fleet_intel_facilities.maintenance),
        owned            = MAX(fleet_intel_facilities.owned, excluded.owned),
        owner_profile_id = COALESCE(excluded.owner_profile_id, fleet_intel_facilities.owner_profile_id),
        build_cost       = COALESCE(fleet_intel_facilities.build_cost, excluded.build_cost),
        last_seen     = datetime('now')
    `)
    for (const g of groups) {
      if (!Array.isArray(g.rows)) continue
      for (const f of g.rows as Array<Record<string, unknown>>) {
        const type = str(f.type || f.facility_type || f.id || '')
        if (!type) continue
        // Live payload carries maintenance_level + maintenance_satisfied, not a
        // `maintenance` string — the old read of f.maintenance left the column
        // empty on all 254 rows.
        const mLvl = typeof f.maintenance_level === 'number' ? f.maintenance_level : null
        const maintenance = str(f.maintenance || '') ||
          (mLvl !== null ? `L${mLvl}${f.maintenance_satisfied === false ? ' UNSATISFIED' : ''}` : '')
        // The catalog knows every facility type's build cost; bank it at first sight.
        // Look up by `type` first (the row key), then facility_id — payloads have
        // carried the catalog id in either field depending on the array.
        const buildCost = (getFacility(type) ?? getFacility(str(f.facility_id || '')))?.build_cost ?? null
        q.run(stationId, type, str(f.name || ''), stationName,
              str(f.status || ''), maintenance,
              g.owned ? 1 : 0, g.owned ? ownerId : null, buildCost, reportedBy)
      }
    }
  }

  /** Harvest the `no_facility` error, which volunteers the nearest public site:
   *  "'Forge Adamantite' is made in a Legend's Anvil, and no facility here can make it.
   *   Nearest public one: The Obsidian Well in Arneb (6 jump(s) away)"
   *  That single sentence is the only reason we ever located the Legend's Anvil, the Heavy
   *  Railgun Assembly Facility or the Thorium Roaster — so stop throwing it away. */
  static processNoFacility(message: string, recipeId: string, reportedBy: string): void {
    const m = /is made in an? ([^,]+?), and no facility here/i.exec(message)
    const n = /Nearest public one:\s*(.+?)\s+in\s+([^(]+?)\s*\(/i.exec(message)
    if (!m || !n) return
    const facilityName = m[1].trim()
    const stationName = n[1].trim()
    const systemName = n[2].trim()
    const facilityType = facilityName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    const stationId = stationName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    getDb().query(`
      INSERT INTO fleet_intel_facilities
        (station_id, facility_type, facility_name, station_name, system_name, recipe_id,
         public, reported_by, notes, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'located via no_facility hint', datetime('now'))
      ON CONFLICT(station_id, facility_type) DO UPDATE SET
        facility_name = COALESCE(NULLIF(excluded.facility_name, ''), fleet_intel_facilities.facility_name),
        system_name   = COALESCE(NULLIF(excluded.system_name, ''),   fleet_intel_facilities.system_name),
        recipe_id     = COALESCE(NULLIF(excluded.recipe_id, ''),     fleet_intel_facilities.recipe_id),
        last_seen     = datetime('now')
    `).run(stationId, facilityType, facilityName, stationName, systemName, recipeId, reportedBy)
  }

  static processNotifications(notifications: unknown[], reportedBy: string): void {
    if (!Array.isArray(notifications)) return
    for (const n of notifications) {
      if (!n || typeof n !== 'object') continue
      const notif = n as R
      const type = str(notif.type || notif.msg_type)
      if (type === 'combat' || type === 'attack') {
        const data = (typeof notif.data === 'object' ? notif.data : {}) as R
        const systemName = str(data.system_name || data.system || '')
        const systemId = str(data.system_id || '')
        if (systemId || systemName) {
          this.insertThreat(systemId, systemName, 'combat', str(data.message || 'Combat detected'), reportedBy)
        }
      }
    }
  }


  /**
   * Capture the per-POI deposit table from a `get_status` / `get_poi` result.
   *
   * Shape (YAML-rendered for readability):
   *   location:
   *     system_id, system_name, poi_id, poi_name, poi_type
   *     resources:
   *       - item_id, item_name, richness, remaining, supported_power
   *
   * `remaining` falls as a deposit is worked and regenerates over days, so rows are
   * upserted with a moving last_seen rather than being treated as static facts.
   */
  private static processLocation(r: R, reportedBy: string): void {
    // Two different shapes arrive here and they disagree on every field name.
    //   get_status : { location: { poi_id, poi_name, poi_type, system_id, resources: [{item_id, item_name, supported_power}] } }
    //   get_poi    : { poi: { id, name, type, system_id, resources: [{resource_id, richness, remaining}] }, resources: [...] }
    // Reading only the get_status names meant every get_poi bailed on the missing
    // poi_id and was silently discarded -- which is the one command fleet doctrine
    // tells agents to run on arrival everywhere. Normalise before touching the DB.
    const loc = (r.location && typeof r.location === 'object') ? (r.location as R) : r
    const poi = (loc.poi && typeof loc.poi === 'object') ? (loc.poi as R) : null

    const poiId = str(loc.poi_id) || (poi ? str(poi.id) : '')
    if (!poiId) return
    const rawResources = Array.isArray(loc.resources) ? loc.resources
      : (poi && Array.isArray(poi.resources)) ? poi.resources : []
    const resources = rawResources
    if (resources.length === 0) return

    const systemId = str(loc.system_id) || (poi ? str(poi.system_id) : '')
    const systemName = str(loc.system_name)
    const poiName = str(loc.poi_name) || (poi ? str(poi.name) : '')
    const poiType = str(loc.poi_type) || (poi ? str(poi.type) : '')

    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_deposits
        (poi_id, item_id, system_id, system_name, poi_name, poi_type, item_name,
         richness, remaining, supported_power, reported_by, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(poi_id, item_id) DO UPDATE SET
        system_id = excluded.system_id,
        -- get_poi carries system_id but NOT system_name. Same guard as item_name below:
        -- without it, every flypast blanked the name a get_status had filled in.
        system_name = CASE WHEN excluded.system_name <> ''
                           THEN excluded.system_name ELSE fleet_intel_deposits.system_name END,
        poi_name = excluded.poi_name,
        poi_type = CASE WHEN excluded.poi_type <> ''
                        THEN excluded.poi_type ELSE fleet_intel_deposits.poi_type END,
        -- get_poi reports richness/remaining but carries no item_name or
        -- supported_power. Overwriting blindly would blank the richer get_status row
        -- every time somebody flew past, so keep the old value when the new one is empty.
        item_name = CASE WHEN excluded.item_name <> ''
                         THEN excluded.item_name ELSE fleet_intel_deposits.item_name END,
        richness = excluded.richness,
        remaining = excluded.remaining,
        supported_power = CASE WHEN excluded.supported_power > 0
                               THEN excluded.supported_power
                               ELSE fleet_intel_deposits.supported_power END,
        reported_by = excluded.reported_by,
        last_seen = datetime('now')
    `)
    for (const res of resources) {
      if (!res || typeof res !== 'object') continue
      const d = res as R
      // get_status calls it item_id; get_poi calls it resource_id.
      const itemId = str(d.item_id) || str(d.resource_id)
      if (!itemId) continue
      upsert.run(
        poiId, itemId, systemId, systemName, poiName, poiType,
        str(d.item_name) || str(d.resource_name), num(d.richness), num(d.remaining),
        num(d.supported_power) || num(d.supports_power),
        reportedBy,
      )
    }
  }

  private static processMarket(r: R, reportedBy: string): void {
    // view_market returns: { station_id, station_name, system_name?, items: [...] } or { summary: [...] }
    // The game sends `base_id` / `base`; this originally read only `station_id`, so the
    // early-return below fired on every single call and fleet_intel_market stayed empty
    // through 375 view_market calls in one day.
    const stationId = str(r.station_id || r.base_id)
    const stationName = str(r.station_name || r.base || r.name || '')
    if (!stationId) return

    // Get system name from context (may be in the result or not)
    const systemName = str(r.system_name || r.system || '')

    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_market (station_id, station_name, system_name, item_id,
                                      best_buy, best_sell, best_buy_qty, best_sell_qty,
                                      reported_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station_id, item_id) DO UPDATE SET
        station_name = excluded.station_name,
        system_name = CASE WHEN excluded.system_name != '' THEN excluded.system_name ELSE fleet_intel_market.system_name END,
        best_buy = excluded.best_buy,
        best_sell = excluded.best_sell,
        -- A report that carried no depth must not erase depth we already have, but any
        -- depth it does carry wins outright -- including 0, since "the bids are gone" is
        -- exactly the news a seller needs.
        best_buy_qty  = COALESCE(excluded.best_buy_qty,  fleet_intel_market.best_buy_qty),
        best_sell_qty = COALESCE(excluded.best_sell_qty, fleet_intel_market.best_sell_qty),
        reported_by = excluded.reported_by,
        updated_at = datetime('now')
    `)

    // One market listing -> one row. Both response shapes land here: the full per-item
    // view (best_buy/best_sell plus buy_orders/sell_orders books) and the compact
    // all-items summary (buy_price/sell_price with buy_quantity/sell_quantity).
    const record = (item: R): void => {
      const itemId = str(item.item_id || item.id || '')
      if (!itemId) return
      const bestBuy = num(item.best_buy_price ?? item.best_buy ?? item.best_bid ?? item.buy_price)
      const bestSell = num(item.best_sell_price ?? item.best_sell ?? item.best_ask ?? item.sell_price)
      upsert.run(stationId, stationName, systemName, itemId,
                 bestBuy, bestSell, bestQty(item, 'buy'), bestQty(item, 'sell'), reportedBy)
    }

    // Full market view with order books
    const items = r.items as R[] | undefined
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        record(item as R)
      }
    }

    // Summary view (compact market listing)
    const summary = r.summary as R[] | undefined
    if (Array.isArray(summary)) {
      for (const item of summary) {
        if (!item || typeof item !== 'object') continue
        record(item as R)
      }
    }
  }

  private static processSystem(r: R, reportedBy: string): void {
    // get_system (v1 http — what every agent currently uses) nests the data:
    //   { action, system: { id, name, empire, police_level, pois: [...] }, security_status }
    // so the system fields live under r.system, NOT at the root. mcp/v2 connections may
    // pre-unwrap via structuredContent, so fall back to r itself. (This deref also repairs a
    // pre-existing bug where has_station/resources were never captured from get_system.)
    const sysObj = (r.system && typeof r.system === 'object') ? (r.system as R) : r
    const systemId = str(sysObj.system_id || sysObj.id || '')
    const systemName = str(sysObj.name || sysObj.system_name || '')
    if (!systemId || !systemName) return

    const pois = Array.isArray(sysObj.pois) ? sysObj.pois : []
    // Station evidence is EXPLICIT, in both directions. A live get_system lists every POI
    // in the system; if none carries a base, there is no station here, whatever the row
    // said before — the old MAX() latch made a wrong flag permanent. A payload with no POI
    // list at all is not evidence either way (null = leave the row alone).
    let hasStation: 0 | 1 | null = pois.length === 0 ? null : (pois.some(poiHasBase) ? 1 : 0)
    if (hasStation === 1 && feedSaysSystemHasStation(systemId) === false) {
      logOnce(`sys:${systemId}`, `[Intel] refusing has_station=1 for ${systemId} (${reportedBy}): the stations feed lists no station there`)
      hasStation = 0
    }
    const feedServices = hasStation === 1 ? feedServicesForSystem(systemId) : null

    // Extract resource types from POIs (best-effort; field may be absent)
    const resources: string[] = []
    for (const p of pois) {
      if (!p || typeof p !== 'object') continue
      const poi = p as R
      const resType = str(poi.resource_type || poi.resource || '')
      if (resType && !resources.includes(resType)) resources.push(resType)
    }

    // Hunting Grounds intel: police level + the POI types where NPC pirates spawn.
    const policeLevel = num(sysObj.police_level)
    const HUNT_TYPES = ['asteroid_belt', 'ice_field', 'gas_cloud']
    const poiTypes: string[] = []
    for (const p of pois) {
      if (!p || typeof p !== 'object') continue
      const t = str((p as R).type).toLowerCase()
      if (HUNT_TYPES.includes(t) && !poiTypes.includes(t)) poiTypes.push(t)
    }

    const db = getDb()
    db.query(`
      INSERT INTO fleet_intel_systems (system_id, system_name, empire, poi_count, has_station, station_services, resources, police_level, poi_types, discovered_by, updated_at)
      VALUES (?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(system_id) DO UPDATE SET
        system_name = excluded.system_name,
        empire = COALESCE(excluded.empire, fleet_intel_systems.empire),
        poi_count = excluded.poi_count,
        -- Explicit set from evidence (a NULL means the payload carried no POI list).
        has_station = COALESCE(?, fleet_intel_systems.has_station),
        -- No station means no services; a refuted or cleared flag takes its copied
        -- service list with it, otherwise the phantom keeps advertising "missions,refuel".
        station_services = CASE WHEN ? = 0 THEN NULL
                                ELSE COALESCE(fleet_intel_systems.station_services, excluded.station_services) END,
        resources = CASE WHEN excluded.resources IS NOT NULL THEN excluded.resources ELSE fleet_intel_systems.resources END,
        police_level = COALESCE(excluded.police_level, fleet_intel_systems.police_level),
        poi_types = CASE WHEN excluded.poi_types IS NOT NULL THEN excluded.poi_types ELSE fleet_intel_systems.poi_types END,
        updated_at = datetime('now')
    `).run(
      systemId, systemName,
      str(sysObj.empire || '') || null,
      pois.length,
      hasStation,
      feedServices,
      resources.length > 0 ? resources.join(',') : null,
      policeLevel,
      poiTypes.length > 0 ? poiTypes.join(',') : null,
      reportedBy,
      hasStation,
      hasStation,
    )
  }

  /**
   * get_base: `{ base: { id, poi_id, name, ... }, services: [...], condition }`. Note what
   * is NOT in that shape: a system_id. Any `system_id` riding on a base payload was put
   * there by something else — a connection's cached location, a caller's argument — and
   * that is how four systems on a hauler's route were stamped with one station's service
   * list in a single minute. So the system is resolved from the BASE'S OWN IDENTITY via
   * the stations feed first; a payload system_id is only trusted when the feed cannot
   * answer, and is refused outright when the feed says that system has no station.
   */
  private static processBase(r: R, reportedBy: string): void {
    const base = (r.base && typeof r.base === 'object') ? (r.base as R) : r
    const baseId = str(base.id || r.base_id || r.station_id || base.base_id || '')
    const claimed = str(r.system_id || base.system_id || '')
    const resolved = baseId ? systemForBase(baseId) : null

    let systemId = resolved ?? claimed
    if (!systemId) return
    if (resolved && claimed && resolved !== claimed) {
      logOnce(`base:${baseId}:${claimed}`,
        `[Intel] get_base for ${baseId} claimed system ${claimed} but the stations feed puts it in ${resolved} (${reportedBy}) — using the feed`)
      systemId = resolved
    }
    if (!resolved && feedSaysSystemHasStation(systemId) === false) {
      logOnce(`base:${systemId}`,
        `[Intel] refusing station flag for ${systemId} from get_base (${reportedBy}): the stations feed lists no station there`)
      return
    }

    const services = r.services as unknown[] | undefined
    const serviceList = Array.isArray(services) ? services.map(s => str(s)).filter(Boolean).join(',') : null

    getDb().query(`
      UPDATE fleet_intel_systems
      SET has_station = 1,
          station_services = COALESCE(?, station_services),
          updated_at = datetime('now')
      WHERE system_id = ?
    `).run(serviceList, systemId)
  }

  private static processNearby(r: R, reportedBy: string): void {
    // KILL-ZONE CAPTURE. get_nearby is the ONLY call that reveals named spawn-node POIs
    // (e.g. "Decay Chain Formation") — get_system omits them entirely. So when an agent
    // scans on-site and finds live pirates OR pirate wrecks, record that NAMED POI as a
    // confirmed kill zone, keyed by poi_id. This is the high-signal complement to the
    // generic low-police-belt atlas built from get_system.
    const poiObj = (r.poi && typeof r.poi === 'object') ? (r.poi as R) : {}
    const poiId = str(poiObj.id || poiObj.poi_id || r.poi_id || '')
    if (!poiId) return

    // get_nearby sometimes returns the current POI nested under `r.poi` and sometimes as flat
    // top-level fields, so the nested-only read left poi_name/system_name NULL (only the slug
    // poi_id survived). Fall back through flat fields, then humanize the slug so a zone always
    // carries a readable label for the Hunt tab / briefing.
    const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const poiName = str(poiObj.name || r.poi_name || r.name || '') || (poiId ? humanize(poiId) : '')
    const poiType = str(poiObj.type || r.poi_type || '')
    let systemId = str(poiObj.system_id || r.system_id || '')
    // get_nearby payloads sometimes carry no system at all — but POI ids embed their
    // system as a prefix (ross_248_cryobelt → ross_248). Longest-prefix match against
    // the known-systems table so a kill zone always lands on the map when possible.
    if (!systemId && poiId) {
      const hit = getDb().query(
        `SELECT system_id FROM fleet_intel_systems WHERE ? LIKE system_id || '_%' ORDER BY LENGTH(system_id) DESC LIMIT 1`
      ).get(poiId) as { system_id: string } | undefined
      if (hit) systemId = hit.system_id
    }
    const systemName = str(poiObj.system_name || r.system_name || '') || (systemId ? humanize(systemId) : '')

    // PLAYER-SIGHTING CAPTURE (ship-class census): every get_nearby lists the players at
    // this POI with their ship_class. Recording them builds, for free, an empirical register
    // of who flies what — the only way to learn whether capital-class hulls (Devastator etc.)
    // actually exist in the wild, since the game exposes no fleet-wide census. Runs BEFORE the
    // kill-zone early return: sightings matter even at peaceful POIs.
    const nearby = Array.isArray(r.nearby) ? (r.nearby as R[]) : []
    if (nearby.length > 0) this.recordSightings(nearby, systemId, systemName, poiId, poiName, reportedBy)

    // Live pirate presence here, right now (strongest signal). Ghost NPCs (permanent
    // unkillable phantoms) are excluded — a ghost-only sighting is NOT combat evidence.
    const pirates = Array.isArray(r.pirates) ? r.pirates : []
    const realPirates = pirates.filter(p => p && typeof p === 'object' && !isGhostPirate(p as R))
    // Count only confirmed ghosts (non-object entries are not ghosts — keep baseline math).
    const ghostCount = pirates.filter(p => p && typeof p === 'object' && isGhostPirate(p as R)).length
    const pirateCount = Math.max(int(r.pirate_count) - ghostCount, realPirates.length, 0)

    // Pirate wrecks here = this POI is a PROVEN kill zone even when the spawn is down.
    const wrecks = Array.isArray(r.wrecks) ? (r.wrecks as R[]) : []
    let pirateWrecks = 0
    for (const w of wrecks) {
      if (w && typeof w === 'object' && str((w as R).type).toLowerCase().includes('pirate')) pirateWrecks++
    }

    // Only record when there is COMBAT EVIDENCE. Empty belts belong in fleet_intel_systems,
    // not here — this table must stay a list of CONFIRMED spawn nodes, not every POI scanned.
    if (pirateCount === 0 && pirateWrecks === 0) return

    const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const db = getDb()
    db.query(`
      INSERT INTO fleet_intel_killzones (poi_id, system_id, system_name, poi_name, poi_type, pirate_seen, wreck_seen, last_pirate_at, discovered_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(poi_id) DO UPDATE SET
        system_id = CASE WHEN excluded.system_id IS NOT NULL THEN excluded.system_id ELSE fleet_intel_killzones.system_id END,
        system_name = CASE WHEN excluded.system_name IS NOT NULL THEN excluded.system_name ELSE fleet_intel_killzones.system_name END,
        poi_name = CASE WHEN excluded.poi_name IS NOT NULL THEN excluded.poi_name ELSE fleet_intel_killzones.poi_name END,
        poi_type = CASE WHEN excluded.poi_type IS NOT NULL THEN excluded.poi_type ELSE fleet_intel_killzones.poi_type END,
        pirate_seen = MAX(fleet_intel_killzones.pirate_seen, excluded.pirate_seen),
        wreck_seen = MAX(fleet_intel_killzones.wreck_seen, excluded.wreck_seen),
        last_pirate_at = CASE WHEN excluded.last_pirate_at IS NOT NULL THEN excluded.last_pirate_at ELSE fleet_intel_killzones.last_pirate_at END,
        ghost = CASE WHEN excluded.pirate_seen > 0 THEN 0 ELSE fleet_intel_killzones.ghost END,
        updated_at = datetime('now')
    `).run(
      poiId,
      systemId || null,
      systemName || null,
      poiName || null,
      poiType || null,
      pirateCount,
      pirateWrecks,
      pirateCount > 0 ? nowUtc : null,
      reportedBy,
    )
  }

  /** Usernames of our own agents — self-sightings are noise, not intel. */
  private static ownUsernames(): Set<string> {
    const rows = getDb().query('SELECT username, name FROM profiles').all() as { username: string | null; name: string }[]
    const set = new Set<string>()
    for (const row of rows) {
      if (row.username) set.add(row.username.toLowerCase())
      // Profile display names often match the in-game username minus a suffix ("Nova Reyes - Miner")
      if (row.name) set.add(row.name.split(' - ')[0].toLowerCase())
    }
    return set
  }

  private static recordSightings(
    players: R[], systemId: string, systemName: string, poiId: string, poiName: string, reportedBy: string,
  ): void {
    const own = this.ownUsernames()
    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_sightings
        (username, player_id, faction_tag, ship_class, ship_name, system_id, system_name, poi_id, poi_name, docked, offline, reported_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        player_id = COALESCE(NULLIF(excluded.player_id, ''), fleet_intel_sightings.player_id),
        faction_tag = COALESCE(NULLIF(excluded.faction_tag, ''), fleet_intel_sightings.faction_tag),
        ship_class = COALESCE(NULLIF(excluded.ship_class, ''), fleet_intel_sightings.ship_class),
        ship_name = COALESCE(NULLIF(excluded.ship_name, ''), fleet_intel_sightings.ship_name),
        system_id = CASE WHEN excluded.system_id != '' THEN excluded.system_id ELSE fleet_intel_sightings.system_id END,
        system_name = CASE WHEN excluded.system_name != '' THEN excluded.system_name ELSE fleet_intel_sightings.system_name END,
        poi_id = CASE WHEN excluded.poi_id != '' THEN excluded.poi_id ELSE fleet_intel_sightings.poi_id END,
        poi_name = CASE WHEN excluded.poi_name != '' THEN excluded.poi_name ELSE fleet_intel_sightings.poi_name END,
        docked = excluded.docked,
        offline = excluded.offline,
        times_seen = fleet_intel_sightings.times_seen + 1,
        last_seen = datetime('now'),
        reported_by = excluded.reported_by
    `)
    for (const p of players) {
      if (!p || typeof p !== 'object') continue
      const username = str(p.username || p.name || '')
      if (!username || own.has(username.toLowerCase())) continue
      upsert.run(
        username,
        str(p.player_id || p.id || ''),
        str(p.faction_tag || p.clan_tag || ''),
        str(p.ship_class || ''),
        str(p.ship_name || ''),
        systemId, systemName, poiId, poiName,
        p.docked ? 1 : 0,
        p.offline ? 1 : 0,
        reportedBy,
      )
    }
  }

  /**
   * WRECK-DENSITY CAPTURE: the free salvage `wrecks` query lists every wreck/container at
   * the current POI with cargo manifests and salvage values. Rows are observations for the
   * scavenger-viability map (density x value per POI), so they intentionally outlive the
   * wrecks themselves. Keyed by wreck UUID; re-sightings bump last_seen.
   */
  private static processWrecks(r: R, reportedBy: string): void {
    const wrecks = Array.isArray(r.wrecks) ? (r.wrecks as R[]) : []
    if (wrecks.length === 0) return
    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_wrecks
        (wreck_id, poi_id, system_id, wreck_type, ship_class, victim_name, killer_name, salvage_value, cargo_summary, expires_at, reported_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wreck_id) DO UPDATE SET
        salvage_value = excluded.salvage_value,
        cargo_summary = excluded.cargo_summary,
        last_seen = datetime('now'),
        reported_by = excluded.reported_by
    `)
    for (const w of wrecks) {
      if (!w || typeof w !== 'object') continue
      const id = str(w.id || w.wreck_id || '')
      if (!id) continue
      const cargo = Array.isArray(w.cargo) ? (w.cargo as R[]) : []
      const cargoSummary = cargo
        .map(ci => `${str(ci.item_id || ci.id)}x${int(ci.quantity) || 1}`)
        .filter(s => s !== 'x1')
        .join(',')
      upsert.run(
        id,
        str(w.poi_id || ''),
        str(w.system_id || ''),
        str(w.type || ''),
        str(w.ship_class || ''),
        str(w.victim_name || ''),
        str(w.killer_name || ''),
        num(w.salvage_value),
        safeTruncate(cargoSummary, 400, '...') || null,
        gameTimestamp(w.expires_at),
        reportedBy,
      )
    }
  }

  private static processScan(r: R, reportedBy: string): void {
    // Scan reveals details about a specific player — could be a threat
    const target = str(r.username || r.name || '')
    if (!target) return

    const systemId = str(r.system_id || '')
    const systemName = str(r.system_name || '')
    const shipClass = str(r.ship_class || (r.ship as R)?.class_name || '')

    // A scan is also the richest possible sighting — record it in the ship-class register.
    this.recordSightings([r], systemId, systemName, str(r.poi_id || ''), str(r.poi_name || ''), reportedBy)

    // Only create threat if we can identify the system
    if (systemId || systemName) {
      this.insertThreat(
        systemId, systemName, 'player_spotted',
        `${target} spotted${shipClass ? ` (${shipClass})` : ''}`,
        reportedBy
      )
    }
  }

  private static processMap(r: R, reportedBy: string): void {
    const systems = r.systems as unknown[] | undefined
    if (!Array.isArray(systems)) return

    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_systems (system_id, system_name, empire, poi_count, discovered_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(system_id) DO UPDATE SET
        system_name = excluded.system_name,
        empire = COALESCE(excluded.empire, fleet_intel_systems.empire),
        poi_count = MAX(fleet_intel_systems.poi_count, excluded.poi_count),
        updated_at = datetime('now')
    `)

    for (const sys of systems) {
      if (!sys || typeof sys !== 'object') continue
      const s = sys as R
      const id = str(s.system_id || s.id || '')
      const name = str(s.name || '')
      if (!id || !name) continue
      upsert.run(id, name, str(s.empire || '') || null, int(s.poi_count), reportedBy)
    }
  }

  private static insertThreat(systemId: string, systemName: string, type: string, description: string, reportedBy: string): void {
    const db = getDb()
    // Expire in 1 hour
    db.query(`
      INSERT INTO fleet_intel_threats (system_id, system_name, threat_type, description, reported_by, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+1 hour'))
    `).run(systemId, systemName, type, description, reportedBy)
  }

  /**
   * Build a concise intel briefing for injection into agent system prompts.
   * Returns empty string if no useful intel exists.
   */
  static buildBriefing(currentSystem?: string): string {
    this.cleanup()

    const db = getDb()
    const sections: string[] = []

    // Active threats (prioritize current system)
    const threats = db.query(`
      SELECT * FROM fleet_intel_threats
      WHERE expires_at > datetime('now')
      ORDER BY
        CASE WHEN system_name = ? OR system_id = ? THEN 0 ELSE 1 END,
        reported_at DESC
      LIMIT 5
    `).all(currentSystem || '', currentSystem || '') as ThreatIntel[]

    if (threats.length > 0) {
      const lines = threats.map(t =>
        `- [${t.threat_type}] ${t.system_name}: ${t.description} (${t.reported_by})`
      )
      sections.push(`### Active Threats\n${lines.join('\n')}`)
    }

    // Market opportunities — biggest spread across stations, ranked by what is actually
    // TRADEABLE rather than by headline margin. Ranking on price alone floated one-unit
    // books to the top of every briefing: crimson_berserker_plating showed a 14,956cr bid
    // that covered exactly one unit, with the next at 8,000. `tradeable` is the smaller of
    // the two sides' at-best depths, so `profit * tradeable` is the whole trade rather than
    // a per-unit fantasy. Rows predating depth capture sort last and say so.
    const opportunities = db.query(`
      SELECT a.item_id,
             a.station_name as buy_station, a.best_sell as buy_price, a.best_sell_qty as buy_depth,
             b.station_name as sell_station, b.best_buy as sell_price, b.best_buy_qty as sell_depth,
             (b.best_buy - a.best_sell) as profit,
             -- Scalar MIN() is NULL if EITHER side is NULL, which is the point: a trade is
             -- only as big as its smaller side, so one unknown side makes the size unknown.
             -- Substituting the known side for the unknown one would manufacture exactly the
             -- false confidence this column exists to remove.
             MIN(a.best_sell_qty, b.best_buy_qty) as tradeable
      FROM fleet_intel_market a
      JOIN fleet_intel_market b ON a.item_id = b.item_id AND a.station_id != b.station_id
      WHERE a.best_sell IS NOT NULL AND a.best_sell > 0
        AND b.best_buy IS NOT NULL AND b.best_buy > 0
        AND b.best_buy > a.best_sell
        AND (a.best_sell_qty IS NULL OR a.best_sell_qty > 0)
        AND (b.best_buy_qty IS NULL OR b.best_buy_qty > 0)
      ORDER BY (tradeable IS NULL),
               CASE WHEN tradeable IS NULL THEN profit ELSE profit * tradeable END DESC
      LIMIT 5
    `).all() as Array<{ item_id: string; buy_station: string; buy_price: number; buy_depth: number | null;
                        sell_station: string; sell_price: number; sell_depth: number | null;
                        profit: number; tradeable: number | null }>

    if (opportunities.length > 0) {
      const n = (v: number) => v.toLocaleString('en-US')
      const deep = (d: number | null) => (d === null ? '' : ` x${n(d)}`)
      const lines = opportunities.map(o =>
        `- ${o.item_id}: buy at ${o.buy_station} (${n(o.buy_price)}cr${deep(o.buy_depth)}) → `
        + `sell at ${o.sell_station} (${n(o.sell_price)}cr${deep(o.sell_depth)}) = ${n(o.profit)}cr/unit`
        + (o.tradeable === null ? ' (depth unknown)' : ` x${n(o.tradeable)} = ${n(o.profit * o.tradeable)}cr`)
      )
      sections.push(`### Market Opportunities (xN = units tradeable at that price)\n${lines.join('\n')}`)
    }

    // Recently discovered systems with stations
    const recentSystems = db.query(`
      SELECT system_name, empire, station_services, resources, discovered_by
      FROM fleet_intel_systems
      WHERE has_station = 1 AND station_services IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 5
    `).all() as SystemIntel[]

    if (recentSystems.length > 0) {
      const lines = recentSystems.map(s => {
        const parts = [s.system_name]
        if (s.empire) parts.push(`(${s.empire})`)
        if (s.station_services) parts.push(`services: ${s.station_services}`)
        return `- ${parts.join(' ')}`
      })
      sections.push(`### Known Stations\n${lines.join('\n')}`)
    }

    if (sections.length === 0) return ''

    const briefing = sections.join('\n\n')
    // Cap at ~1500 chars to avoid bloating the prompt
    return safeTruncate(briefing, 1497, '...')
  }

  /** Wreck observations for the scavenger-viability density map, freshest first. */
  static getWreckObservations(limit = 500): Array<Record<string, unknown>> {
    return getDb().query('SELECT * FROM fleet_intel_wrecks ORDER BY last_seen DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>
  }

  /** Where can we craft X? Owned facilities first — those cost us upkeep and should be
   *  used before flying to a public one. */
  static getFacilities(opts: { type?: string; recipe?: string; ownedOnly?: boolean } = {}):
      Array<Record<string, unknown>> {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.type) { where.push('(facility_type LIKE ? OR facility_name LIKE ?)'); args.push(`%${opts.type}%`, `%${opts.type}%`) }
    if (opts.recipe) { where.push('recipe_id = ?'); args.push(opts.recipe) }
    if (opts.ownedOnly) where.push('owned = 1')
    const sql = `SELECT * FROM fleet_intel_facilities
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY owned DESC, last_seen DESC LIMIT 500`
    return getDb().query(sql).all(...args) as Array<Record<string, unknown>>
  }

  /** Register a facility the fleet BUILT. These are assets with upkeep, not just places we
   *  happen to have access to, so they are flagged `owned` and never expire from pruning. */
  static recordOwnedFacility(f: {
    stationId: string; facilityType: string; facilityName?: string; stationName?: string
    systemName?: string; recipeId?: string; buildCost?: number; ownerProfileId?: string
    reportedBy: string; notes?: string
  }): void {
    getDb().query(`
      INSERT INTO fleet_intel_facilities
        (station_id, facility_type, facility_name, station_name, system_name, recipe_id,
         public, owned, owner_profile_id, build_cost, notes, reported_by, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station_id, facility_type) DO UPDATE SET
        owned = 1, public = 0,
        owner_profile_id = COALESCE(excluded.owner_profile_id, fleet_intel_facilities.owner_profile_id),
        build_cost       = COALESCE(excluded.build_cost,       fleet_intel_facilities.build_cost),
        facility_name    = COALESCE(NULLIF(excluded.facility_name, ''), fleet_intel_facilities.facility_name),
        station_name     = COALESCE(NULLIF(excluded.station_name, ''),  fleet_intel_facilities.station_name),
        system_name      = COALESCE(NULLIF(excluded.system_name, ''),   fleet_intel_facilities.system_name),
        recipe_id        = COALESCE(NULLIF(excluded.recipe_id, ''),     fleet_intel_facilities.recipe_id),
        notes            = COALESCE(NULLIF(excluded.notes, ''),         fleet_intel_facilities.notes),
        last_seen        = datetime('now')
    `).run(f.stationId, f.facilityType, f.facilityName ?? '', f.stationName ?? '',
           f.systemName ?? '', f.recipeId ?? '', f.ownerProfileId ?? null,
           f.buildCost ?? null, f.notes ?? '', f.reportedBy)
  }

  /** Remove expired threats */
  static cleanup(): void {
    getDb().query("DELETE FROM fleet_intel_threats WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run()
  }

  /** Get all intel for the REST API */
  static getAll(): FleetIntelData {
    this.cleanup()
    const db = getDb()

    const market = db.query('SELECT * FROM fleet_intel_market ORDER BY updated_at DESC').all() as MarketIntel[]
    const systems = db.query('SELECT * FROM fleet_intel_systems ORDER BY updated_at DESC').all() as SystemIntel[]
    const threats = db.query("SELECT * FROM fleet_intel_threats WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY reported_at DESC").all() as ThreatIntel[]
    const sightings = this.getSightings()

    // Convert has_station integer to boolean for frontend
    for (const s of systems) {
      (s as unknown as R).has_station = Boolean((s as unknown as R).has_station)
    }

    return { market, systems, threats, sightings }
  }

  /**
   * Player-sighting register (ship-class census), freshest first. Pass a shipClassFilter
   * (case-insensitive substring, e.g. "devastator" or "battlecruiser") to hunt capital hulls.
   */
  static getSightings(limit = 200, shipClassFilter?: string): PlayerSighting[] {
    if (shipClassFilter) {
      return getDb().query(`
        SELECT * FROM fleet_intel_sightings
        WHERE ship_class LIKE '%' || ? || '%'
        ORDER BY last_seen DESC LIMIT ?
      `).all(shipClassFilter, limit) as PlayerSighting[]
    }
    return getDb().query('SELECT * FROM fleet_intel_sightings ORDER BY last_seen DESC LIMIT ?')
      .all(limit) as PlayerSighting[]
  }

  /**
   * Hunting Grounds: low/zero-police systems that have a belt/ice/gas POI — i.e. where
   * NPC pirates spawn (per the pirate-hunter doctrine: pirates live in unpoliced space).
   * Only returns systems actually scanned via get_system (police_level IS NOT NULL); rows
   * known only from get_map have NULL police and are correctly excluded.
   */
  static getHuntingGrounds(maxPolice = 20): SystemIntel[] {
    this.cleanup()
    return getDb().query(`
      SELECT * FROM fleet_intel_systems
      WHERE police_level IS NOT NULL AND police_level <= ?
        AND (poi_types LIKE '%asteroid_belt%' OR poi_types LIKE '%ice_field%' OR poi_types LIKE '%gas_cloud%')
      ORDER BY police_level ASC, poi_count DESC, updated_at DESC
      LIMIT 50
    `).all(maxPolice) as SystemIntel[]
  }

  /**
   * Confirmed kill zones: NAMED spawn-node POIs where pirates / pirate wrecks were actually
   * observed via on-site get_nearby. Ordered by freshest live-pirate sighting first, then by
   * wreck evidence. These are the highest-signal combat targets the fleet knows about.
   */
  static getKillZones(limit = 25, includeGhosts = false): KillZone[] {
    return getDb().query(`
      SELECT * FROM fleet_intel_killzones
      ${includeGhosts ? '' : 'WHERE ghost = 0'}
      ORDER BY
        CASE WHEN last_pirate_at IS NOT NULL THEN 0 ELSE 1 END,
        last_pirate_at DESC,
        wreck_seen DESC,
        updated_at DESC
      LIMIT ?
    `).all(limit) as KillZone[]
  }

  /**
   * Compact, append-only briefing for a combat agent: CONFIRMED KILL ZONES (named spawn nodes)
   * first, then the nearest low-police belts. Injected into the per-turn ephemeral message (NOT
   * the cached system prompt), so newly discovered grounds never invalidate the prompt cache.
   * Empty string if nothing useful is known.
   */
  static buildHuntingBriefing(currentSystem?: string): string {
    const sections: string[] = []

    // 1) Confirmed kill zones — named POIs where pirates actually spawned (get_system can't see these).
    const zones = this.getKillZones(8)
    if (zones.length > 0) {
      const lines = zones.map(z => {
        const sys = z.system_name || z.system_id || '?'
        const where = z.poi_name || z.poi_id
        const type = z.poi_type ? ` [${z.poi_type}]` : ''
        const evid = z.pirate_seen > 0
          ? `pirates seen (max ${z.pirate_seen})`
          : `${z.wreck_seen} pirate wreck${z.wreck_seen === 1 ? '' : 's'}`
        const fresh = z.last_pirate_at ? ` — last pirates ${z.last_pirate_at} UTC` : ''
        return `- ${sys} → ${where}${type}: ${evid}${fresh}`
      })
      sections.push(
        '## CONFIRMED KILL ZONES (named spawn POIs — pirates/wrecks actually seen here)\n' +
        'These NAMED POIs are where pirates ACTUALLY spawn. get_system does NOT list them, so: ' +
        'find_route/jump to the SYSTEM, then get_nearby to reach the named POI. Camp the one with the ' +
        'freshest pirate sighting — the spawn is on a TIMER, so HOLD and re-scan rather than leaving on ' +
        'one empty scan.\n' +
        lines.join('\n')
      )
    }

    // 2) Generic low-police belts (broad coverage from get_system).
    const grounds = this.getHuntingGrounds(20)
    if (grounds.length > 0) {
      const norm = (s: string) => (s || '').toLowerCase().replace(/_/g, ' ').trim()
      const here = currentSystem ? grounds.find(g => norm(g.system_name) === norm(currentSystem)) : undefined
      const ordered = here ? [here, ...grounds.filter(g => g !== here)] : grounds
      const lines = ordered.slice(0, 6).map(s => {
        const types = (s.poi_types || '')
          .split(',')
          .map(t => t.replace('asteroid_belt', 'belt').replace('ice_field', 'ice').replace('gas_cloud', 'gas'))
          .join('/')
        const hereTag = here && s === here ? '  [YOU ARE HERE — hunt it]' : ''
        return `- ${s.system_name}: ${types} | ${s.police_level} police${hereTag}`
      })
      sections.push(
        '## NEAREST LOW-POLICE BELTS (pirate hunting grounds — scanned by your fleet)\n' +
        'Rotate these belt/ice/gas systems to find NPC pirates already present. Lower police = more pirates. ' +
        'If a system is not listed, get_system it on arrival to add it to the fleet map.\n' +
        lines.join('\n')
      )
    }

    return sections.join('\n\n')
  }
}

/**
 * Build the SCARCE RESOURCE REGISTER — an ephemeral, zero-cost digest of where the
 * fleet has actually seen the ores that are hard to find.
 *
 * Why this exists: agents kept flying blind. One ran 12 jumps hunting copper while the
 * register held six belts at ~100,000 units of it; another searched three systems for
 * silicon we had recorded at richness 44 with 20,000 remaining. The data was there and
 * queryable — nobody queried it, because nothing put it in front of them.
 *
 * MUST be injected as an EPHEMERAL per-turn message, never into the cached system
 * prompt: `remaining` changes on every scan, and a per-turn-changing byte in the cached
 * prompt rebuilds ~25-31k tokens and busts the prompt-cache prefix (measured: ~65% of
 * LLM spend was spurious cacheWrites). Same rule as buildFactionBriefing.
 */
/** How old a scan is, in words an agent can act on. A bare number reads as current fact;
 *  "14d old" tells the reader to expect the belt to be stripped and plan a fallback. */
function fmtAge(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'age unknown'
  if (hours < 1) return 'fresh'
  if (hours < 24) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}

export function buildDepositBriefing(): string {
  const db = getDb()
  type Row = { item_id: string; item_name: string; system_name: string; poi_name: string; richness: number; remaining: number; age_h: number }

  // "Abundant" = you will trip over it, so it needs no directions. The bar has to be high:
  // at >= 3 POIs this swallowed silicon_ore, which sits at exactly 3 known fields and had an
  // agent hunting it across five systems for an hour while the register told him it was
  // "never worth a search". Iron and copper are at ~139 POIs; that is abundant. Three is not.
  const ABUNDANT_MIN_POIS = 8
  const abundant = db.query(
    `SELECT item_id, COUNT(*) AS n FROM fleet_intel_deposits
     WHERE remaining > 10000 GROUP BY item_id HAVING n >= ?`
  ).all(ABUNDANT_MIN_POIS) as Array<{ item_id: string; n: number }>
  const abundantSet = new Set(abundant.map(r => r.item_id))

  // Age matters as much as quantity. On 2026-08-20, 845 of the 939 stocked deposits were
  // over a week old, and three agents in one hour flew to fields the register still listed
  // as rich — Ledger hit six stripped belts in a row. A number with no date reads as fact.
  const rows = db.query(
    `SELECT item_id, item_name, system_name, poi_name, richness, remaining,
            (julianday('now') - julianday(last_seen)) * 24 AS age_h
     FROM fleet_intel_deposits WHERE remaining > 0 ORDER BY remaining DESC`
  ).all() as Row[]

  const bestPerItem = new Map<string, Row[]>()
  for (const r of rows) {
    if (abundantSet.has(r.item_id)) continue
    const list = bestPerItem.get(r.item_id) ?? []
    if (list.length < 2) { list.push(r); bestPerItem.set(r.item_id, list) }
  }
  if (bestPerItem.size === 0 && abundantSet.size === 0) return ''

  // Take BOTH ends of the workable range, because neither sort alone is right.
  // Scarcest-first alone fills the list with exhausted deposits (tritium at ~1 unit).
  // Richest-first alone buries the very things agents hunt: silver/cobalt/platinum at
  // ~22,000 crowd out titanium at ~1,818. So: the scarce-but-still-workable items first
  // (those genuinely need directions), then the biggest deposits we know of.
  // Anything under WORKABLE_FLOOR is not a destination and earns no space.
  const WORKABLE_FLOOR = 50
  const workable = [...bestPerItem.entries()]
    .filter(([, list]) => (list[0]?.remaining ?? 0) >= WORKABLE_FLOOR)
  const scarcest = [...workable].sort((a, b) => (a[1][0]?.remaining ?? 0) - (b[1][0]?.remaining ?? 0)).slice(0, 10)
  const richest = [...workable].sort((a, b) => (b[1][0]?.remaining ?? 0) - (a[1][0]?.remaining ?? 0)).slice(0, 8)
  const seen = new Set(scarcest.map(([k]) => k))
  const ordered = [...scarcest, ...richest.filter(([k]) => !seen.has(k))]

  const lines: string[] = []
  for (const [, list] of ordered) {
    const head = list[0]
    if (!head) continue
    const where = list
      .map(r => `${r.system_name || '?'}/${r.poi_name} r${r.richness} ~${r.remaining} (${fmtAge(r.age_h)})`)
      .join('  ·  ')
    lines.push(`- ${head.item_name || head.item_id}: ${where}`)
  }

  const out = [
    '## SCARCE RESOURCE REGISTER (your fleet\'s own scans — do not go searching blind)',
    'Every line came from a `get_poi` somebody already ran. **Each entry carries the age of',
    'that scan — read it before you commit jumps.** Anything marked in days is a historical',
    'reading, not a promise: most week-old fields have since been mined out, so treat them as',
    'leads to verify, and plan a fallback before you fly. Entries marked `fresh` or in hours',
    'are worth trusting. Still: do NOT burn jumps hunting a resource nobody has listed here,',
    'and do not assume something is gone because one belt was stripped.',
    'When you scan a field, that reading updates this register for everyone — reporting a',
    'stripped belt is real work, not a wasted turn.',
    ...lines,
  ]
  if (abundantSet.size > 0) {
    // Name one field per abundant item rather than just the item. "It is everywhere" is
    // useless to an agent who still has to pick a destination, and it reads as "do not
    // bother looking" — which is how a miner ends up searching five systems for a
    // resource the register could have pointed at directly.
    const example = new Map<string, Row>()
    for (const r of rows) if (abundantSet.has(r.item_id) && !example.has(r.item_id)) example.set(r.item_id, r)
    const shown = [...abundantSet].slice(0, 8).map(id => {
      const e = example.get(id)
      return e ? `${e.item_name || id} (${e.system_name || '?'}/${e.poi_name})` : id
    })
    out.push('ABUNDANT — you will trip over these, but here is the richest known field for each anyway:')
    out.push('  ' + shown.join(' · '))
  }

  // Name the exhausted ones explicitly. Silence reads as "not looked at yet" and sends
  // somebody to check; "we looked, it is gone" ends the search.
  const dead = [...bestPerItem.entries()]
    .filter(([, list]) => (list[0]?.remaining ?? 0) < WORKABLE_FLOOR)
    .map(([, list]) => `${list[0]?.item_name || '?'} (~${list[0]?.remaining})`)
  if (dead.length > 0) {
    out.push(`WORKED OUT — best known deposit is effectively empty, do not go looking: ${dead.slice(0, 8).join(', ')}`)
  }
  return out.join('\n')
}
