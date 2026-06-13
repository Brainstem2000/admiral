import { getDb } from './db'
import { safeTruncate } from './text-safe'
import type { FleetIntelData, MarketIntel, SystemIntel, ThreatIntel, KillZone } from '../../shared/fleet-intel-types'

type R = Record<string, unknown>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null }
function int(v: unknown): number { return typeof v === 'number' ? Math.floor(v) : 0 }

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

    switch (command) {
      case 'view_market': return this.processMarket(r, reportedBy)
      case 'get_system': return this.processSystem(r, reportedBy)
      case 'get_base': return this.processBase(r, reportedBy)
      case 'get_nearby': return this.processNearby(r, reportedBy)
      case 'scan': return this.processScan(r, reportedBy)
      case 'get_map': return this.processMap(r, reportedBy)
    }
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

  private static processMarket(r: R, reportedBy: string): void {
    // view_market returns: { station_id, station_name, system_name?, items: [...] } or { summary: [...] }
    const stationId = str(r.station_id)
    const stationName = str(r.station_name || r.name || '')
    if (!stationId) return

    // Get system name from context (may be in the result or not)
    const systemName = str(r.system_name || r.system || '')

    const db = getDb()
    const upsert = db.query(`
      INSERT INTO fleet_intel_market (station_id, station_name, system_name, item_id, best_buy, best_sell, reported_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station_id, item_id) DO UPDATE SET
        station_name = excluded.station_name,
        system_name = CASE WHEN excluded.system_name != '' THEN excluded.system_name ELSE fleet_intel_market.system_name END,
        best_buy = excluded.best_buy,
        best_sell = excluded.best_sell,
        reported_by = excluded.reported_by,
        updated_at = datetime('now')
    `)

    // Full market view with order books
    const items = r.items as R[] | undefined
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const itemId = str((item as R).item_id || (item as R).id || '')
        if (!itemId) continue
        const bestBuy = num((item as R).best_buy_price ?? (item as R).best_buy)
        const bestSell = num((item as R).best_sell_price ?? (item as R).best_sell)
        upsert.run(stationId, stationName, systemName, itemId, bestBuy, bestSell, reportedBy)
      }
    }

    // Summary view (compact market listing)
    const summary = r.summary as R[] | undefined
    if (Array.isArray(summary)) {
      for (const item of summary) {
        if (!item || typeof item !== 'object') continue
        const itemId = str((item as R).item_id || (item as R).id || '')
        if (!itemId) continue
        const bestBuy = num((item as R).best_buy ?? (item as R).buy_price)
        const bestSell = num((item as R).best_sell ?? (item as R).sell_price)
        upsert.run(stationId, stationName, systemName, itemId, bestBuy, bestSell, reportedBy)
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
    const hasStation = pois.some((p: unknown) => {
      if (!p || typeof p !== 'object') return false
      const poi = p as R
      return str(poi.type).includes('station') || str(poi.type).includes('base')
    })

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
      INSERT INTO fleet_intel_systems (system_id, system_name, empire, poi_count, has_station, resources, police_level, poi_types, discovered_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(system_id) DO UPDATE SET
        system_name = excluded.system_name,
        empire = COALESCE(excluded.empire, fleet_intel_systems.empire),
        poi_count = excluded.poi_count,
        has_station = MAX(fleet_intel_systems.has_station, excluded.has_station),
        resources = CASE WHEN excluded.resources IS NOT NULL THEN excluded.resources ELSE fleet_intel_systems.resources END,
        police_level = COALESCE(excluded.police_level, fleet_intel_systems.police_level),
        poi_types = CASE WHEN excluded.poi_types IS NOT NULL THEN excluded.poi_types ELSE fleet_intel_systems.poi_types END,
        updated_at = datetime('now')
    `).run(
      systemId, systemName,
      str(sysObj.empire || '') || null,
      pois.length,
      hasStation ? 1 : 0,
      resources.length > 0 ? resources.join(',') : null,
      policeLevel,
      poiTypes.length > 0 ? poiTypes.join(',') : null,
      reportedBy,
    )
  }

  private static processBase(r: R, reportedBy: string): void {
    const systemId = str(r.system_id || '')
    const systemName = str(r.system_name || '')
    if (!systemId && !systemName) return

    const services = r.services as unknown[] | undefined
    const serviceList = Array.isArray(services) ? services.map(s => str(s)).filter(Boolean).join(',') : null

    const db = getDb()
    if (systemId) {
      db.query(`
        UPDATE fleet_intel_systems
        SET has_station = 1,
            station_services = COALESCE(?, station_services),
            updated_at = datetime('now')
        WHERE system_id = ?
      `).run(serviceList, systemId)
    }
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
    const systemId = str(poiObj.system_id || r.system_id || '')
    const systemName = str(poiObj.system_name || r.system_name || '') || (systemId ? humanize(systemId) : '')

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

  private static processScan(r: R, reportedBy: string): void {
    // Scan reveals details about a specific player — could be a threat
    const target = str(r.username || r.name || '')
    if (!target) return

    const systemId = str(r.system_id || '')
    const systemName = str(r.system_name || '')
    const shipClass = str(r.ship_class || (r.ship as R)?.class_name || '')

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

    // Market opportunities — find items with biggest buy/sell spread across stations
    const opportunities = db.query(`
      SELECT a.item_id,
             a.station_name as buy_station, a.best_sell as buy_price,
             b.station_name as sell_station, b.best_buy as sell_price,
             (b.best_buy - a.best_sell) as profit
      FROM fleet_intel_market a
      JOIN fleet_intel_market b ON a.item_id = b.item_id AND a.station_id != b.station_id
      WHERE a.best_sell IS NOT NULL AND a.best_sell > 0
        AND b.best_buy IS NOT NULL AND b.best_buy > 0
        AND b.best_buy > a.best_sell
      ORDER BY profit DESC
      LIMIT 5
    `).all() as Array<{ item_id: string; buy_station: string; buy_price: number; sell_station: string; sell_price: number; profit: number }>

    if (opportunities.length > 0) {
      const lines = opportunities.map(o =>
        `- ${o.item_id}: buy at ${o.buy_station} (${o.buy_price}cr) → sell at ${o.sell_station} (${o.sell_price}cr) = ${o.profit}cr profit`
      )
      sections.push(`### Market Opportunities\n${lines.join('\n')}`)
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

    // Convert has_station integer to boolean for frontend
    for (const s of systems) {
      (s as unknown as R).has_station = Boolean((s as unknown as R).has_station)
    }

    return { market, systems, threats }
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
