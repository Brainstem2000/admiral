import { Database } from 'bun:sqlite'
import path from 'path'
import fs from 'fs'
import type { Provider, Profile, LogEntry } from '../../shared/types'
import type { GalaxyMapData } from '../../shared/galaxy-types'

const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'admiral.db')

let db: Database | null = null

export function getDb(): Database {
  if (db) {
    // Verify the DB file still exists and connection is healthy
    if (!fs.existsSync(DB_PATH)) {
      try { db.close() } catch { /* ignore */ }
      db = null
    } else {
      try {
        // Quick health check - try a real query
        db.query('SELECT 1 FROM profiles LIMIT 1').get()
        return db
      } catch {
        try { db.close() } catch { /* ignore */ }
        db = null
      }
    }
  }

  // Bun on Windows can throw EEXIST from mkdirSync even with { recursive: true }
  // when the directory already exists (observed on OneDrive-backed paths), where
  // Node/POSIX would treat it as a no-op. Tolerate that so boots after the first
  // one don't crash; only a genuine creation failure should propagate.
  try {
    fs.mkdirSync(DB_DIR, { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
  }
  db = new Database(DB_PATH)
  // The database holds plaintext secrets (SpaceMolt passwords, LLM API keys).
  // Restrict perms so other local users can't read it. Best-effort (no-op on
  // platforms/filesystems that don't support POSIX modes, e.g. Windows).
  try {
    fs.chmodSync(DB_DIR, 0o700)
    fs.chmodSync(DB_PATH, 0o600)
  } catch { /* ignore */ }
  // Incremental auto-vacuum lets pruneOldData() hand freed pages back to the OS via
  // `PRAGMA incremental_vacuum`, so the file can SHRINK as old logs are pruned instead of only
  // ever growing. Must be set before any table exists to take effect on a fresh DB; an existing
  // non-incremental DB adopts it only after a one-time VACUUM (done during the size-cleanup).
  db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      api_key TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      status TEXT DEFAULT 'unknown'
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      username TEXT,
      password TEXT,
      empire TEXT DEFAULT '',
      player_id TEXT,
      provider TEXT,
      model TEXT,
      directive TEXT DEFAULT '',
      connection_mode TEXT DEFAULT 'http',
      server_url TEXT DEFAULT 'https://game.spacemolt.com',
      autoconnect INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      summary TEXT,
      detail TEXT,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_log_profile ON log_entries(profile_id, id);
  `)

  // Migrations: add columns that may be missing from older databases
  const profileCols = db.query("PRAGMA table_info(profiles)").all() as Array<{ name: string }>
  if (!profileCols.some(c => c.name === 'todo')) {
    db.exec("ALTER TABLE profiles ADD COLUMN todo TEXT DEFAULT ''")
  }
  if (!profileCols.some(c => c.name === 'context_budget')) {
    db.exec('ALTER TABLE profiles ADD COLUMN context_budget REAL DEFAULT NULL')
  }
  if (!profileCols.some(c => c.name === 'memory')) {
    db.exec("ALTER TABLE profiles ADD COLUMN memory TEXT DEFAULT ''")
  }
  if (!profileCols.some(c => c.name === 'sort_order')) {
    db.exec('ALTER TABLE profiles ADD COLUMN sort_order INTEGER DEFAULT 0')
    // Backfill: assign order based on creation time
    db.exec(`
      UPDATE profiles SET sort_order = (
        SELECT COUNT(*) FROM profiles p2 WHERE p2.created_at <= profiles.created_at AND p2.id != profiles.id
      )
    `)
  }
  if (!profileCols.some(c => c.name === 'group_name')) {
    db.exec("ALTER TABLE profiles ADD COLUMN group_name TEXT DEFAULT ''")
  }
  if (!profileCols.some(c => c.name === 'planner_provider')) {
    db.exec('ALTER TABLE profiles ADD COLUMN planner_provider TEXT DEFAULT NULL')
  }
  if (!profileCols.some(c => c.name === 'planner_model')) {
    db.exec('ALTER TABLE profiles ADD COLUMN planner_model TEXT DEFAULT NULL')
  }
  if (!profileCols.some(c => c.name === 'planning_interval')) {
    db.exec('ALTER TABLE profiles ADD COLUMN planning_interval INTEGER DEFAULT NULL')
  }

  // Galaxy map cache (single-row table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS galaxy_map (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `)

  // Preferences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `)

  // Fleet intel tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_intel_market (
      station_id TEXT NOT NULL,
      station_name TEXT NOT NULL,
      system_name TEXT NOT NULL,
      item_id TEXT NOT NULL,
      best_buy INTEGER,
      best_sell INTEGER,
      reported_by TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(station_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fim_item ON fleet_intel_market(item_id);

    CREATE TABLE IF NOT EXISTS fleet_intel_systems (
      system_id TEXT PRIMARY KEY,
      system_name TEXT NOT NULL,
      empire TEXT,
      poi_count INTEGER DEFAULT 0,
      has_station INTEGER DEFAULT 0,
      station_services TEXT,
      resources TEXT,
      police_level INTEGER,
      poi_types TEXT,
      discovered_by TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fleet_intel_threats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id TEXT NOT NULL,
      system_name TEXT NOT NULL,
      threat_type TEXT NOT NULL,
      description TEXT NOT NULL,
      reported_by TEXT NOT NULL,
      reported_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fit_system ON fleet_intel_threats(system_id);

    -- Confirmed kill zones: NAMED POIs where pirates / pirate wrecks were observed via
    -- get_nearby. These are the spawn nodes get_system is BLIND to (e.g. "Decay Chain
    -- Formation" never appears in get_system's POI list), so they are captured separately,
    -- keyed by poi_id and sourced only from on-site get_nearby scans.
    CREATE TABLE IF NOT EXISTS fleet_intel_killzones (
      poi_id TEXT PRIMARY KEY,
      system_id TEXT,
      system_name TEXT,
      poi_name TEXT,
      poi_type TEXT,
      pirate_seen INTEGER DEFAULT 0,
      wreck_seen INTEGER DEFAULT 0,
      last_pirate_at TEXT,
      discovered_by TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fik_system ON fleet_intel_killzones(system_id);
  `)

  // Financial snapshots for session-level tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS financial_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      wallet INTEGER DEFAULT 0,
      storage INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fsnap_profile ON financial_snapshots(profile_id, timestamp);
  `)

  // Financial ledger: per-event credit movements parsed from game command results.
  // amount_signed: positive = income, negative = expense. The partial UNIQUE index
  // dedupes events that occur at most once per order_id (e.g. a mission reward echoed
  // on both the command result and a notification) — inserts use INSERT OR IGNORE so
  // the replay lands on the index, not a dupe row. order_fill and combat are
  // deliberately NOT covered: an order legitimately fills in N partial fills sharing
  // one order_id, and a unique index would silently drop fills 2..N.
  db.exec(`
    CREATE TABLE IF NOT EXISTS financial_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      item_id TEXT,
      quantity REAL,
      unit_price REAL,
      amount_signed INTEGER NOT NULL,
      counterparty TEXT,
      order_id TEXT,
      balance_after INTEGER,
      source_command TEXT NOT NULL,
      raw_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fled_profile ON financial_ledger(profile_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fled_order ON financial_ledger(order_id);
    CREATE INDEX IF NOT EXISTS idx_fled_item ON financial_ledger(item_id);
    DROP INDEX IF EXISTS idx_fled_dedupe;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fled_dedupe2 ON financial_ledger(profile_id, order_id, kind)
      WHERE order_id IS NOT NULL AND kind IN ('order_create', 'order_cancel', 'mission_reward', 'other');
  `)

  // Agent schedules for cron-like automation
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'connect_llm',
      duration_hours REAL DEFAULT NULL,
      enabled INTEGER DEFAULT 1,
      last_run_at TEXT DEFAULT NULL,
      next_run_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sched_profile ON schedules(profile_id);
    CREATE INDEX IF NOT EXISTS idx_sched_next ON schedules(next_run_at);
  `)

  // Event-driven wake triggers
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_triggers (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_match TEXT DEFAULT NULL,
      action TEXT NOT NULL DEFAULT 'nudge',
      action_params TEXT DEFAULT NULL,
      enabled INTEGER DEFAULT 1,
      last_fired_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_etrig_profile ON event_triggers(profile_id);
  `)

  // Fleet orders for cross-agent task delegation (convoy system)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_orders (
      id TEXT PRIMARY KEY,
      from_profile_id TEXT NOT NULL,
      to_profile_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      params TEXT DEFAULT NULL,
      status TEXT DEFAULT 'pending',
      progress TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (to_profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ford_to ON fleet_orders(to_profile_id, status);
    CREATE INDEX IF NOT EXISTS idx_ford_from ON fleet_orders(from_profile_id);
  `)

  // Migrate fleet_orders: add chain support
  const fordCols = db.query("PRAGMA table_info(fleet_orders)").all() as { name: string }[]
  if (!fordCols.some(c => c.name === 'chain_id')) {
    db.exec('ALTER TABLE fleet_orders ADD COLUMN chain_id TEXT DEFAULT NULL')
    db.exec('CREATE INDEX IF NOT EXISTS idx_ford_chain ON fleet_orders(chain_id)')
  }
  if (!fordCols.some(c => c.name === 'next_orders')) {
    db.exec('ALTER TABLE fleet_orders ADD COLUMN next_orders TEXT DEFAULT NULL')
  }

  // Migrate fleet_intel_systems: add police_level + poi_types for the Hunting Grounds finder.
  // Kept NULLABLE (no DEFAULT) so "never scanned via get_system" (NULL) stays distinct from
  // "lawless" (0) — the getHuntingGrounds query relies on `police_level IS NOT NULL`.
  const fisCols = db.query("PRAGMA table_info(fleet_intel_systems)").all() as { name: string }[]
  if (!fisCols.some(c => c.name === 'police_level')) {
    db.exec('ALTER TABLE fleet_intel_systems ADD COLUMN police_level INTEGER')
    db.exec('CREATE INDEX IF NOT EXISTS idx_fis_police ON fleet_intel_systems(police_level)')
  }
  if (!fisCols.some(c => c.name === 'poi_types')) {
    db.exec('ALTER TABLE fleet_intel_systems ADD COLUMN poi_types TEXT')
  }

  // Migrate fleet_intel_killzones: ghost flag for permanently-present unkillable phantom
  // NPCs (e.g. "Murmur Load" at ross_248_cryobelt). Ghost rows are kept for the UI but
  // excluded from hunting briefings so agents stop chasing unattackable spawns.
  const fikCols = db.query("PRAGMA table_info(fleet_intel_killzones)").all() as { name: string }[]
  if (!fikCols.some(c => c.name === 'ghost')) {
    db.exec('ALTER TABLE fleet_intel_killzones ADD COLUMN ghost INTEGER DEFAULT 0')
    // One-time data fix: the existing ross_248_cryobelt row is the Murmur Load phantom.
    db.exec("UPDATE fleet_intel_killzones SET ghost = 1 WHERE poi_id = 'ross_248_cryobelt'")
  }

  // Drop legacy table (storage credits now parsed from agent memory)
  db.exec('DROP TABLE IF EXISTS fleet_intel_storage_credits')

  // Clean up legacy preferences
  db.exec("DELETE FROM preferences WHERE key = 'display_format'")

  // Seed default providers
  const defaultProviders = [
    'claude-max', 'anthropic', 'openai', 'groq', 'google', 'xai',
    'mistral', 'minimax', 'nvidia', 'openrouter', 'ollama', 'lmstudio', 'custom',
  ]
  const upsert = db.query(
    'INSERT OR IGNORE INTO providers (id) VALUES (?)'
  )
  for (const p of defaultProviders) {
    upsert.run(p)
  }
}

// --- Provider CRUD ---

export function listProviders(): Provider[] {
  return getDb().query('SELECT * FROM providers ORDER BY id').all() as Provider[]
}

export function getProvider(id: string): Provider | undefined {
  return getDb().query('SELECT * FROM providers WHERE id = ?').get(id) as Provider | undefined
}

export function upsertProvider(id: string, apiKey: string, baseUrl: string, status: string): void {
  getDb().query(
    `INSERT INTO providers (id, api_key, base_url, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET api_key = ?, base_url = ?, status = ?`
  ).run(id, apiKey, baseUrl, status, apiKey, baseUrl, status)
}

// --- Profile CRUD ---

function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    ...row,
    autoconnect: !!row.autoconnect,
    enabled: !!row.enabled,
  } as Profile
}

export function listProfiles(): Profile[] {
  const rows = getDb().query('SELECT * FROM profiles ORDER BY sort_order ASC, created_at ASC').all() as Record<string, unknown>[]
  return rows.map(rowToProfile)
}

export function getProfile(id: string): Profile | undefined {
  const row = getDb().query('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToProfile(row) : undefined
}

export function createProfile(profile: Omit<Profile, 'created_at' | 'updated_at'>): Profile {
  getDb().query(
    `INSERT INTO profiles (id, name, username, password, empire, player_id, provider, model, planner_provider, planner_model, planning_interval, directive, todo, memory, connection_mode, server_url, autoconnect, enabled, context_budget, sort_order, group_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profile.id, profile.name, profile.username, profile.password,
    profile.empire, profile.player_id, profile.provider, profile.model,
    profile.planner_provider ?? null, profile.planner_model ?? null, profile.planning_interval ?? null,
    profile.directive, profile.todo || '', profile.memory || '', profile.connection_mode, profile.server_url,
    profile.autoconnect ? 1 : 0, profile.enabled ? 1 : 0, profile.context_budget ?? null,
    profile.sort_order ?? 0, profile.group_name || '',
  )
  return getProfile(profile.id)!
}

export function updateProfile(id: string, updates: Partial<Profile>): Profile | undefined {
  const allowed = [
    'name', 'username', 'password', 'empire', 'player_id',
    'provider', 'model', 'planner_provider', 'planner_model', 'planning_interval',
    'directive', 'connection_mode', 'server_url',
    'autoconnect', 'enabled', 'todo', 'memory', 'context_budget',
    'sort_order', 'group_name',
  ]
  const sets: string[] = []
  const vals: unknown[] = []

  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      let val = (updates as Record<string, unknown>)[key]
      if (key === 'autoconnect' || key === 'enabled') val = val ? 1 : 0
      vals.push(val)
    }
  }

  if (sets.length === 0) return getProfile(id)

  sets.push("updated_at = datetime('now')")
  vals.push(id)

  getDb().query(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getProfile(id)
}

export function deleteProfile(id: string): void {
  getDb().query('DELETE FROM profiles WHERE id = ?').run(id)
}

export function reorderProfiles(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.query('UPDATE profiles SET sort_order = ? WHERE id = ?')
  for (let i = 0; i < orderedIds.length; i++) {
    stmt.run(i, orderedIds[i])
  }
}

// --- Log CRUD ---

export function addLogEntry(profileId: string, type: string, summary: string, detail?: string): number {
  const result = getDb().query(
    'INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)'
  ).run(profileId, type, summary, detail ?? null)
  return Number(result.lastInsertRowid)
}

export function getLogEntries(profileId: string, afterId?: number, limit: number = 100): LogEntry[] {
  if (afterId) {
    return getDb().query(
      'SELECT * FROM log_entries WHERE profile_id = ? AND id > ? ORDER BY id LIMIT ?'
    ).all(profileId, afterId, limit) as LogEntry[]
  }
  return getDb().query(
    'SELECT * FROM log_entries WHERE profile_id = ? ORDER BY id DESC LIMIT ?'
  ).all(profileId, limit) as LogEntry[]
}

export function clearLogs(profileId: string): void {
  getDb().query('DELETE FROM log_entries WHERE profile_id = ?').run(profileId)
}

/**
 * Cross-profile timeline query: returns log entries from ALL profiles,
 * ordered by id (chronological), with optional type filtering.
 */
export function getTimelineEntries(opts: {
  afterId?: number
  limit?: number
  types?: string[]
  profileIds?: string[]
}): LogEntry[] {
  const { afterId, limit = 200, types, profileIds } = opts
  const conditions: string[] = []
  const params: unknown[] = []

  if (afterId) {
    conditions.push('id > ?')
    params.push(afterId)
  }
  if (types && types.length > 0) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  if (profileIds && profileIds.length > 0) {
    conditions.push(`profile_id IN (${profileIds.map(() => '?').join(',')})`)
    params.push(...profileIds)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const query = afterId
    ? `SELECT * FROM log_entries ${where} ORDER BY id LIMIT ?`
    : `SELECT * FROM log_entries ${where} ORDER BY id DESC LIMIT ?`
  params.push(limit)

  const rows = getDb().query(query).all(...params) as LogEntry[]
  return afterId ? rows : rows.reverse()
}

/**
 * Aggregate token usage and cost from llm_call log entries.
 * Parses the JSON detail field for each llm_call entry.
 */
export function getTokenAnalytics(opts: {
  profileId?: string
  since?: string
}): {
  byProfile: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>
  timeline: { timestamp: string; cost: number; tokens: number; profile_id: string; model: string }[]
} {
  const { profileId, since } = opts
  const conditions = ["type = 'llm_call'"]
  const params: unknown[] = []

  if (profileId) {
    conditions.push('profile_id = ?')
    params.push(profileId)
  }
  if (since) {
    conditions.push('timestamp >= ?')
    params.push(since)
  }

  // Default to last 24 hours if no since filter — prevents loading 70k+ rows into memory
  if (!since) {
    conditions.push('timestamp >= ?')
    params.push(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '))
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const db = getDb()

  const byProfile: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }> = {}
  const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }> = {}

  // Aggregate in SQL so totals/cost/ROI are exact regardless of row count.
  // (The previous JS aggregation pulled rows with LIMIT 10000 and silently
  // undercounted when the window held more than that.)
  const aggRows = db.query(
    `SELECT profile_id,
            COALESCE(json_extract(detail, '$.model'), 'unknown') AS model,
            COUNT(*) AS calls,
            COALESCE(SUM(CAST(json_extract(detail, '$.usage.input')  AS REAL)), 0) AS inputTokens,
            COALESCE(SUM(CAST(json_extract(detail, '$.usage.output') AS REAL)), 0) AS outputTokens,
            COALESCE(SUM(CAST(json_extract(detail, '$.usage.cost.total') AS REAL)), 0) AS cost
     FROM log_entries ${where} AND detail IS NOT NULL
     GROUP BY profile_id, model`
  ).all(...params) as { profile_id: string; model: string; calls: number; inputTokens: number; outputTokens: number; cost: number }[]

  for (const r of aggRows) {
    if (!byProfile[r.profile_id]) byProfile[r.profile_id] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    byProfile[r.profile_id].calls += r.calls
    byProfile[r.profile_id].inputTokens += r.inputTokens
    byProfile[r.profile_id].outputTokens += r.outputTokens
    byProfile[r.profile_id].cost += r.cost

    if (!byModel[r.model]) byModel[r.model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    byModel[r.model].calls += r.calls
    byModel[r.model].inputTokens += r.inputTokens
    byModel[r.model].outputTokens += r.outputTokens
    byModel[r.model].cost += r.cost
  }

  // Timeline is a per-call series for the cumulative-cost chart. Bound it to the
  // most recent points so a very active window can't load unbounded rows; return
  // chronological order so the running total reads left-to-right.
  const TIMELINE_LIMIT = 5000
  const tlRows = db.query(
    `SELECT timestamp, profile_id,
            COALESCE(json_extract(detail, '$.model'), 'unknown') AS model,
            COALESCE(CAST(json_extract(detail, '$.usage.cost.total') AS REAL), 0) AS cost,
            COALESCE(CAST(json_extract(detail, '$.usage.input')  AS REAL), 0)
              + COALESCE(CAST(json_extract(detail, '$.usage.output') AS REAL), 0) AS tokens
     FROM log_entries ${where} AND detail IS NOT NULL
     ORDER BY id DESC LIMIT ${TIMELINE_LIMIT}`
  ).all(...params) as { timestamp: string; cost: number; tokens: number; profile_id: string; model: string }[]
  const timeline = tlRows.reverse()

  return { byProfile, byModel, timeline }
}

/**
 * Delete aged operational data so these tables don't grow without bound over a
 * long-running deployment. Logs, snapshots and intel are all transient/derived,
 * so old rows can be discarded. Returns the number of rows removed per table.
 */
export function pruneOldData(opts?: {
  logDays?: number
  snapshotDays?: number
  intelDays?: number
  ledgerDays?: number
  maxLogRows?: number
}): { logs: number; snapshots: number; intel: number; ledger: number } {
  const logDays = opts?.logDays ?? 14
  const snapshotDays = opts?.snapshotDays ?? 30
  const intelDays = opts?.intelDays ?? 7
  const ledgerDays = opts?.ledgerDays ?? 90
  // Hard ceiling on log rows. Age-based pruning alone cannot bound this table when write volume
  // is high (many agents each logging every turn), so we ALSO cap absolute row count and drop the
  // oldest rows beyond it. With the trimmed llm_call detail this is a few hundred MB at most.
  const maxLogRows = opts?.maxLogRows ?? 120_000
  const db = getDb()
  const cutoff = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

  let logs = db.query('DELETE FROM log_entries WHERE timestamp < ?').run(cutoff(logDays)).changes
  // Row-count cap: find the id of the maxLogRows-th most-recent row and delete everything older.
  // Uses the primary-key index, so it stays cheap even on a large table.
  const threshold = db.query('SELECT id FROM log_entries ORDER BY id DESC LIMIT 1 OFFSET ?')
    .get(maxLogRows) as { id: number } | undefined
  if (threshold) {
    logs += db.query('DELETE FROM log_entries WHERE id < ?').run(threshold.id).changes
  }
  const snapshots = db.query('DELETE FROM financial_snapshots WHERE timestamp < ?').run(cutoff(snapshotDays)).changes
  const intelCutoff = cutoff(intelDays)
  const m = db.query('DELETE FROM fleet_intel_market WHERE updated_at < ?').run(intelCutoff).changes
  const s = db.query('DELETE FROM fleet_intel_systems WHERE updated_at < ?').run(intelCutoff).changes
  // Kill zones are rare + high-value; retain ~4x longer than ordinary intel before pruning.
  // Ghost rows are pinned: ghost-only sightings never refresh updated_at (filtered at
  // capture), and a pruned phantom row could never be re-created — keep it for the UI tag.
  const kz = db.query('DELETE FROM fleet_intel_killzones WHERE updated_at < ? AND ghost = 0').run(cutoff(intelDays * 4)).changes
  const ledger = db.query('DELETE FROM financial_ledger WHERE timestamp < ?').run(cutoff(ledgerDays)).changes

  // Hand freed pages back to the OS so the file actually shrinks after a prune. No-op unless the
  // DB uses auto_vacuum = INCREMENTAL (set at init; existing DBs adopt it after the one-time VACUUM).
  try { db.exec('PRAGMA incremental_vacuum') } catch { /* ignore */ }

  return { logs, snapshots, intel: m + s + kz, ledger }
}

// --- Preferences CRUD ---

export function getPreference(key: string): string | null {
  const row = getDb().query('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setPreference(key: string, value: string): void {
  getDb().query(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, value, value)
}

export function getAllPreferences(): Record<string, string> {
  const rows = getDb().query('SELECT key, value FROM preferences').all() as Array<{ key: string; value: string }>
  const prefs: Record<string, string> = {}
  for (const row of rows) prefs[row.key] = row.value
  return prefs
}

// --- Galaxy Map Cache ---

export function getGalaxyMap(): GalaxyMapData | null {
  const row = getDb().query('SELECT data FROM galaxy_map WHERE id = 1').get() as { data: string } | undefined
  if (!row) return null
  return JSON.parse(row.data) as GalaxyMapData
}

export function setGalaxyMap(data: GalaxyMapData): void {
  getDb().query(
    `INSERT INTO galaxy_map (id, data, fetched_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = ?, fetched_at = ?`
  ).run(JSON.stringify(data), data.fetched_at, JSON.stringify(data), data.fetched_at)
}

// --- Financial Snapshots ---

export function addFinancialSnapshot(profileId: string, wallet: number, storage: number): void {
  getDb().query(
    'INSERT INTO financial_snapshots (profile_id, wallet, storage, total) VALUES (?, ?, ?, ?)'
  ).run(profileId, wallet, storage, wallet + storage)
}

// --- Schedule CRUD ---

export interface Schedule {
  id: string
  profile_id: string
  cron: string
  action: string
  duration_hours: number | null
  enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
}

export function listSchedules(profileId?: string): Schedule[] {
  if (profileId) {
    const rows = getDb().query('SELECT * FROM schedules WHERE profile_id = ? ORDER BY created_at').all(profileId) as Record<string, unknown>[]
    return rows.map(r => ({ ...r, enabled: !!r.enabled } as Schedule))
  }
  const rows = getDb().query('SELECT * FROM schedules ORDER BY next_run_at ASC').all() as Record<string, unknown>[]
  return rows.map(r => ({ ...r, enabled: !!r.enabled } as Schedule))
}

export function getSchedule(id: string): Schedule | undefined {
  const row = getDb().query('SELECT * FROM schedules WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  return { ...row, enabled: !!row.enabled } as Schedule
}

export function upsertSchedule(schedule: Omit<Schedule, 'created_at'>): void {
  getDb().query(
    `INSERT INTO schedules (id, profile_id, cron, action, duration_hours, enabled, last_run_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cron = ?, action = ?, duration_hours = ?, enabled = ?, next_run_at = ?`
  ).run(
    schedule.id, schedule.profile_id, schedule.cron, schedule.action,
    schedule.duration_hours, schedule.enabled ? 1 : 0, schedule.last_run_at, schedule.next_run_at,
    schedule.cron, schedule.action, schedule.duration_hours, schedule.enabled ? 1 : 0, schedule.next_run_at,
  )
}

export function deleteSchedule(id: string): void {
  getDb().query('DELETE FROM schedules WHERE id = ?').run(id)
}

export function updateScheduleRun(id: string, lastRunAt: string, nextRunAt: string | null): void {
  getDb().query('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(lastRunAt, nextRunAt, id)
}

// --- Event Trigger CRUD ---

export interface EventTrigger {
  id: string
  profile_id: string
  event_type: string
  event_match: string | null
  action: string
  action_params: string | null
  enabled: boolean
  last_fired_at: string | null
  created_at: string
}

export function listEventTriggers(profileId?: string): EventTrigger[] {
  if (profileId) {
    const rows = getDb().query('SELECT * FROM event_triggers WHERE profile_id = ? ORDER BY created_at').all(profileId) as Record<string, unknown>[]
    return rows.map(r => ({ ...r, enabled: !!r.enabled } as EventTrigger))
  }
  const rows = getDb().query('SELECT * FROM event_triggers ORDER BY created_at').all() as Record<string, unknown>[]
  return rows.map(r => ({ ...r, enabled: !!r.enabled } as EventTrigger))
}

export function upsertEventTrigger(trigger: Omit<EventTrigger, 'created_at'>): void {
  getDb().query(
    `INSERT INTO event_triggers (id, profile_id, event_type, event_match, action, action_params, enabled, last_fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET event_type = ?, event_match = ?, action = ?, action_params = ?, enabled = ?`
  ).run(
    trigger.id, trigger.profile_id, trigger.event_type, trigger.event_match,
    trigger.action, trigger.action_params, trigger.enabled ? 1 : 0, trigger.last_fired_at,
    trigger.event_type, trigger.event_match, trigger.action, trigger.action_params, trigger.enabled ? 1 : 0,
  )
}

export function deleteEventTrigger(id: string): void {
  getDb().query('DELETE FROM event_triggers WHERE id = ?').run(id)
}

export function markEventTriggerFired(id: string): void {
  getDb().query("UPDATE event_triggers SET last_fired_at = datetime('now') WHERE id = ?").run(id)
}

// --- Fleet Orders (Convoy System) ---

export interface FleetOrder {
  id: string
  from_profile_id: string
  to_profile_id: string
  type: string
  description: string
  params: string | null
  status: string
  progress: string | null
  chain_id: string | null
  next_orders: string | null
  created_at: string
  updated_at: string
}

export function createFleetOrder(order: Pick<FleetOrder, 'id' | 'from_profile_id' | 'to_profile_id' | 'type' | 'description' | 'params'> & { chain_id?: string | null; next_orders?: string | null }): void {
  getDb().query(
    `INSERT INTO fleet_orders (id, from_profile_id, to_profile_id, type, description, params, chain_id, next_orders)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(order.id, order.from_profile_id, order.to_profile_id, order.type, order.description, order.params, order.chain_id ?? null, order.next_orders ?? null)
}

export function getFleetOrders(opts: {
  toProfileId?: string
  fromProfileId?: string
  status?: string
}): FleetOrder[] {
  const conditions: string[] = []
  const params: string[] = []
  if (opts.toProfileId) { conditions.push('to_profile_id = ?'); params.push(opts.toProfileId) }
  if (opts.fromProfileId) { conditions.push('from_profile_id = ?'); params.push(opts.fromProfileId) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return getDb().query(`SELECT * FROM fleet_orders ${where} ORDER BY created_at DESC`).all(...params) as FleetOrder[]
}

export function updateFleetOrder(id: string, updates: { status?: string; progress?: string }): void {
  const sets: string[] = ["updated_at = datetime('now')"]
  const vals: string[] = []
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status) }
  if (updates.progress !== undefined) { sets.push('progress = ?'); vals.push(updates.progress) }
  vals.push(id)
  getDb().query(`UPDATE fleet_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function getFleetOrdersByChain(chainId: string): FleetOrder[] {
  return getDb().query('SELECT * FROM fleet_orders WHERE chain_id = ? ORDER BY created_at ASC').all(chainId) as FleetOrder[]
}

export function deleteFleetOrder(id: string): void {
  getDb().query('DELETE FROM fleet_orders WHERE id = ?').run(id)
}

export function getFinancialSnapshots(opts: {
  profileId?: string
  since?: string
  limit?: number
}): Array<{ profile_id: string; timestamp: string; wallet: number; storage: number; total: number }> {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (opts.profileId) {
    conditions.push('profile_id = ?')
    params.push(opts.profileId)
  }
  if (opts.since) {
    conditions.push('timestamp >= ?')
    params.push(opts.since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit || 2000
  return getDb().query(
    `SELECT profile_id, timestamp, wallet, storage, total FROM financial_snapshots ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...params, limit).reverse() as Array<{ profile_id: string; timestamp: string; wallet: number; storage: number; total: number }>
}
