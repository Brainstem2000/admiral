import { getDb } from './db'
import type { FleetIntelData, MarketIntel, SystemIntel, ThreatIntel } from '../../shared/fleet-intel-types'

type R = Record<string, unknown>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null }
function int(v: unknown): number { return typeof v === 'number' ? Math.floor(v) : 0 }

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
    const systemId = str(r.system_id || r.id || '')
    const systemName = str(r.name || r.system_name || '')
    if (!systemId || !systemName) return

    const pois = Array.isArray(r.pois) ? r.pois : []
    const hasStation = pois.some((p: unknown) => {
      if (!p || typeof p !== 'object') return false
      const poi = p as R
      return str(poi.type).includes('station') || str(poi.type).includes('base')
    })

    // Extract resource types from POIs
    const resources: string[] = []
    for (const p of pois) {
      if (!p || typeof p !== 'object') continue
      const poi = p as R
      const resType = str(poi.resource_type || poi.resource || '')
      if (resType && !resources.includes(resType)) resources.push(resType)
    }

    const db = getDb()
    db.query(`
      INSERT INTO fleet_intel_systems (system_id, system_name, empire, poi_count, has_station, resources, discovered_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(system_id) DO UPDATE SET
        system_name = excluded.system_name,
        empire = COALESCE(excluded.empire, fleet_intel_systems.empire),
        poi_count = excluded.poi_count,
        has_station = MAX(fleet_intel_systems.has_station, excluded.has_station),
        resources = CASE WHEN excluded.resources IS NOT NULL THEN excluded.resources ELSE fleet_intel_systems.resources END,
        updated_at = datetime('now')
    `).run(
      systemId, systemName,
      str(r.empire || '') || null,
      pois.length,
      hasStation ? 1 : 0,
      resources.length > 0 ? resources.join(',') : null,
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
    const players = r.players as unknown[] | undefined
    if (!Array.isArray(players) || players.length === 0) return

    const systemId = str(r.system_id || '')
    const systemName = str(r.system_name || '')

    for (const p of players) {
      if (!p || typeof p !== 'object') continue
      const player = p as R
      const name = str(player.username || player.name || 'Unknown')
      const faction = str(player.faction || '')
      // Only flag as threat if they seem hostile (armed, at war, etc.)
      // For now just record player presence without creating threat — too noisy otherwise
    }
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
    return briefing.length > 1500 ? briefing.slice(0, 1497) + '...' : briefing
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
}
