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
    CREATE INDEX IF NOT EXISTS idx_log_type_ts ON log_entries(type, timestamp, id);
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
  // Per-agent opt-in for the volatile/stable prompt split (see buildSystemPrompt).
  // When set, memory, TODO, the fleet-intel and situational briefings, and pending
  // fleet orders are delivered as a per-turn message instead of being interpolated
  // into the cached system prompt — they change constantly and were invalidating the
  // whole cached prefix, which is where the cache-write cost came from.
  if (!profileCols.some(c => c.name === 'volatile_split')) {
    db.exec('ALTER TABLE profiles ADD COLUMN volatile_split INTEGER DEFAULT 0')
  }
  if (!profileCols.some(c => c.name === 'codex_executor_enabled')) {
    db.exec('ALTER TABLE profiles ADD COLUMN codex_executor_enabled INTEGER DEFAULT 0')
  }
  if (!profileCols.some(c => c.name === 'codex_executor_model')) {
    db.exec('ALTER TABLE profiles ADD COLUMN codex_executor_model TEXT DEFAULT NULL')
  }
  if (!profileCols.some(c => c.name === 'codex_planner_enabled')) {
    db.exec('ALTER TABLE profiles ADD COLUMN codex_planner_enabled INTEGER DEFAULT 0')
  }
  if (!profileCols.some(c => c.name === 'codex_planner_model')) {
    db.exec('ALTER TABLE profiles ADD COLUMN codex_planner_model TEXT DEFAULT NULL')
  }

  // Codex app-server threads are isolated by profile and role. Removing this
  // mapping is sufficient to start a clean thread; Admiral state remains in
  // profiles and is injected again as the authoritative prompt.
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_sessions (
      profile_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('planner', 'executor')),
      thread_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_schema_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, role),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    -- Automatic recovery history for the three pieces of durable agent state.
    -- Provider switches never write these fields, but the history gives us a
    -- second guardrail against an accidental future overwrite.
    CREATE TABLE IF NOT EXISTS profile_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('directive', 'todo', 'memory')),
      value TEXT NOT NULL DEFAULT '',
      changed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_profile_state_history
      ON profile_state_history(profile_id, field, id DESC);

    CREATE TRIGGER IF NOT EXISTS preserve_profile_directive
      BEFORE UPDATE OF directive ON profiles
      WHEN OLD.directive IS NOT NEW.directive
      BEGIN
        INSERT INTO profile_state_history(profile_id, field, value)
        VALUES (OLD.id, 'directive', COALESCE(OLD.directive, ''));
      END;

    CREATE TRIGGER IF NOT EXISTS preserve_profile_todo
      BEFORE UPDATE OF todo ON profiles
      WHEN OLD.todo IS NOT NEW.todo
      BEGIN
        INSERT INTO profile_state_history(profile_id, field, value)
        VALUES (OLD.id, 'todo', COALESCE(OLD.todo, ''));
      END;

    CREATE TRIGGER IF NOT EXISTS preserve_profile_memory
      BEFORE UPDATE OF memory ON profiles
      WHEN OLD.memory IS NOT NEW.memory
      BEGIN
        INSERT INTO profile_state_history(profile_id, field, value)
        VALUES (OLD.id, 'memory', COALESCE(OLD.memory, ''));
      END;
  `)

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

    CREATE TABLE IF NOT EXISTS fleet_intel_wrecks (
      wreck_id TEXT PRIMARY KEY,
      poi_id TEXT,
      system_id TEXT,
      wreck_type TEXT,
      ship_class TEXT,
      victim_name TEXT,
      killer_name TEXT,
      salvage_value INTEGER,
      cargo_summary TEXT,
      expires_at TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      reported_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fiw_poi ON fleet_intel_wrecks(poi_id);

    CREATE TABLE IF NOT EXISTS fleet_intel_sightings (
      username TEXT PRIMARY KEY,
      player_id TEXT,
      faction_tag TEXT,
      ship_class TEXT,
      ship_name TEXT,
      system_id TEXT,
      system_name TEXT,
      poi_id TEXT,
      poi_name TEXT,
      docked INTEGER DEFAULT 0,
      offline INTEGER DEFAULT 0,
      times_seen INTEGER DEFAULT 1,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      reported_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fis_class ON fleet_intel_sightings(ship_class);
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

  // Per-agent lifetime sell allowances for BoM-locked items (Admiral surplus
  // quotas). Enforced in tools.ts: locked items cannot be sold by ANY path
  // unless a row here has remaining > 0. Agent-memory quota tracking failed
  // twice in one night (armor_plate 60 sold vs 25; mass_driver 4 vs 3).
  db.exec(`
    CREATE TABLE IF NOT EXISTS sell_quotas (
      profile_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      remaining REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, item_id)
    );
  `)

  // Fleet-wide storage ledger: what each agent holds at each station.
  //
  // The directives make every agent keep a prose STORAGE LEDGER in memory, but
  // prose drifts — Nova's Confederacy Central Command depot (1,148 nickel ore,
  // 263 iron ore, a spare mining laser, 3 parked ships) sat forgotten while the
  // fleet hunted the same materials elsewhere. This table is the machine-kept
  // version: every view_storage response any agent makes updates it, so it costs
  // no extra game calls and can never disagree with what the game actually said.
  //
  // A snapshot REPLACES that (profile, station) pair wholesale rather than
  // merging — an item absent from a fresh read is genuinely gone, and merging
  // would resurrect it forever.
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_inventory (
      profile_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT DEFAULT '',
      quantity INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, station_id, item_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stinv_item ON storage_inventory(item_id);
    CREATE INDEX IF NOT EXISTS idx_stinv_station ON storage_inventory(station_id);

    CREATE TABLE IF NOT EXISTS storage_ships (
      profile_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      ship_id TEXT NOT NULL,
      class TEXT DEFAULT '',
      custom_name TEXT DEFAULT '',
      module_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, station_id, ship_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stships_station ON storage_ships(station_id);

    -- Ship holds. Storage alone loses sight of everything in transit: a hauler
    -- carrying 200 thorium between systems showed as owning nothing, so deliveries
    -- appeared to materialise out of nowhere and the fleet repeatedly re-mined
    -- material it was already carrying. One row set per profile (an agent flies one
    -- ship at a time); replaced wholesale like the storage snapshot.
    CREATE TABLE IF NOT EXISTS cargo_inventory (
      profile_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT DEFAULT '',
      quantity INTEGER NOT NULL,
      ship_id TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, item_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cargo_item ON cargo_inventory(item_id);

    -- Mirror of the game's own action log. Snapshots are only true at the instant
    -- they are read; this is the event stream between them. Reconciliation against
    -- live truth showed 89.7% snapshot accuracy, and most of the miss was simply
    -- age — a transfer six minutes old already made the ledger wrong.
    CREATE TABLE IF NOT EXISTS action_events (
      profile_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      category TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (profile_id, event_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_evt_created ON action_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_evt_type ON action_events(event_type);

    -- Per (agent, category) high-water mark so ingestion is incremental.
    CREATE TABLE IF NOT EXISTS action_cursor (
      profile_id TEXT NOT NULL,
      category TEXT NOT NULL,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, category)
    );

    -- Storage events (deposit/withdraw) carry NO station id, and Admiral has no
    -- position history to place them with. Rather than guess a station and be
    -- silently wrong, we mark the agent's storage dirty and let the next
    -- view_storage settle it. Honest staleness beats confident fiction.
    -- Per-POI deposit intel: what a location actually holds, how rich it is, and
    -- the mining power it supports.
    --
    -- This is the single most valuable intel in the game and it was never captured.
    -- get_status carries the full resource table on nearly every turn — item_id,
    -- richness, remaining, supported_power — and the collector had no handler for it,
    -- so fleet_intel_systems.resources sat at 0/505 populated. Agents rediscovered
    -- deposits constantly; Goldcrest was eventually found by regexing raw log YAML
    -- because there was nowhere to look it up.
    --
    -- Keyed per (poi, item) because deposits are per-POI, not per-system, and a belt
    -- holds several. remaining moves as it is mined and regenerates over days, so
    -- last_seen matters as much as the number.
    CREATE TABLE IF NOT EXISTS fleet_intel_deposits (
      poi_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      system_id TEXT DEFAULT '',
      system_name TEXT DEFAULT '',
      poi_name TEXT DEFAULT '',
      poi_type TEXT DEFAULT '',
      item_name TEXT DEFAULT '',
      richness INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0,
      supported_power INTEGER DEFAULT 0,
      reported_by TEXT DEFAULT '',
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (poi_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dep_item ON fleet_intel_deposits(item_id);
    CREATE INDEX IF NOT EXISTS idx_dep_system ON fleet_intel_deposits(system_id);

    CREATE TABLE IF NOT EXISTS storage_dirty (
      profile_id TEXT NOT NULL,
      reason TEXT DEFAULT '',
      since TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id)
    );
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
    'claude-max', 'codex-business', 'anthropic', 'openai', 'groq', 'google', 'xai',
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
    codex_executor_enabled: !!row.codex_executor_enabled,
    codex_planner_enabled: !!row.codex_planner_enabled,
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
    `INSERT INTO profiles (id, name, username, password, empire, player_id, provider, model, planner_provider, planner_model, planning_interval, codex_executor_enabled, codex_executor_model, codex_planner_enabled, codex_planner_model, directive, todo, memory, connection_mode, server_url, autoconnect, enabled, context_budget, sort_order, group_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profile.id, profile.name, profile.username, profile.password,
    profile.empire, profile.player_id, profile.provider, profile.model,
    profile.planner_provider ?? null, profile.planner_model ?? null, profile.planning_interval ?? null,
    profile.codex_executor_enabled ? 1 : 0, profile.codex_executor_model ?? null,
    profile.codex_planner_enabled ? 1 : 0, profile.codex_planner_model ?? null,
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
    'codex_executor_enabled', 'codex_executor_model', 'codex_planner_enabled', 'codex_planner_model',
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
      if (key === 'autoconnect' || key === 'enabled' || key === 'codex_executor_enabled' || key === 'codex_planner_enabled') val = val ? 1 : 0
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

export interface CodexSession {
  profile_id: string
  role: 'planner' | 'executor'
  thread_id: string
  model: string
  tool_schema_hash: string
  created_at: string
  updated_at: string
}

export function getCodexSession(profileId: string, role: CodexSession['role']): CodexSession | undefined {
  return getDb().query(
    'SELECT * FROM codex_sessions WHERE profile_id = ? AND role = ?'
  ).get(profileId, role) as CodexSession | undefined
}

export function upsertCodexSession(
  profileId: string,
  role: CodexSession['role'],
  threadId: string,
  model: string,
  toolSchemaHash: string,
): void {
  getDb().query(
    `INSERT INTO codex_sessions (profile_id, role, thread_id, model, tool_schema_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, role) DO UPDATE SET
       thread_id = excluded.thread_id,
       model = excluded.model,
       tool_schema_hash = excluded.tool_schema_hash,
       updated_at = datetime('now')`
  ).run(profileId, role, threadId, model, toolSchemaHash)
}

export function deleteCodexSession(profileId: string, role: CodexSession['role']): void {
  getDb().query(
    'DELETE FROM codex_sessions WHERE profile_id = ? AND role = ?'
  ).run(profileId, role)
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
  // Cap only the PERSISTED copy of tool_result detail. The full result is still
  // handed to the LLM in-context by the caller; this truncation affects the DB row
  // alone, keeping the log_entries table from bloating on huge tool payloads.
  let persistedDetail = detail ?? null
  const TOOL_RESULT_DETAIL_CEILING = 32768
  if (type === 'tool_result' && persistedDetail !== null && persistedDetail.length > TOOL_RESULT_DETAIL_CEILING) {
    const dropped = persistedDetail.length - TOOL_RESULT_DETAIL_CEILING
    persistedDetail = persistedDetail.slice(0, TOOL_RESULT_DETAIL_CEILING) + `\n…[truncated ${dropped} bytes]`
  }
  const result = getDb().query(
    'INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)'
  ).run(profileId, type, summary, persistedDetail)
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
  // Player sightings age out on last_seen; like kill zones they are sparse and high-value,
  // so keep them ~4x longer than ordinary intel.
  const si = db.query('DELETE FROM fleet_intel_sightings WHERE last_seen < ?').run(cutoff(intelDays * 4)).changes
  // Wreck observations are density-measurement data: rows outlive the wrecks themselves
  // (that is the point), but 3 weeks is plenty for the map.
  const wr = db.query('DELETE FROM fleet_intel_wrecks WHERE last_seen < ?').run(cutoff(21)).changes
  const ledger = db.query('DELETE FROM financial_ledger WHERE timestamp < ?').run(cutoff(ledgerDays)).changes

  // Hand freed pages back to the OS so the file actually shrinks after a prune. No-op unless the
  // DB uses auto_vacuum = INCREMENTAL (set at init; existing DBs adopt it after the one-time VACUUM).
  try { db.exec('PRAGMA incremental_vacuum') } catch { /* ignore */ }

  return { logs, snapshots, intel: m + s + kz + si + wr, ledger }
}

// --- Preferences CRUD ---

// --- sell quotas (BoM-locked item allowances) ---

export function getSellQuota(profileId: string, itemId: string): number | null {
  const row = db.query('SELECT remaining FROM sell_quotas WHERE profile_id = ? AND item_id = ?')
    .get(profileId, itemId) as { remaining: number } | null
  return row ? row.remaining : null
}

export function decrementSellQuota(profileId: string, itemId: string, quantity: number): void {
  db.query('UPDATE sell_quotas SET remaining = MAX(0, remaining - ?), updated_at = datetime(\'now\') WHERE profile_id = ? AND item_id = ?')
    .run(quantity, profileId, itemId)
}

// ── Storage ledger ────────────────────────────────────────────────────────────

export interface StorageItem { item_id: string; item_name?: string; quantity: number }
export interface StorageShip { ship_id: string; class?: string; custom_name?: string; module_count?: number }
export interface StorageRow extends StorageItem { profile_id: string; station_id: string; updated_at: string }

/**
 * Replace this agent's recorded holdings at one station with a fresh snapshot.
 * Wholesale replace, not merge: an item missing from a new read has actually
 * left the station, and merging would keep it on the books forever.
 */
export function recordStorageSnapshot(
  profileId: string,
  stationId: string,
  items: StorageItem[],
  ships: StorageShip[] = [],
): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM storage_inventory WHERE profile_id = ? AND station_id = ?').run(profileId, stationId)
    const ins = db.query(`INSERT INTO storage_inventory (profile_id, station_id, item_id, item_name, quantity)
      VALUES (?, ?, ?, ?, ?)`)
    for (const it of items) {
      if (!it.item_id || !(it.quantity > 0)) continue
      ins.run(profileId, stationId, it.item_id, it.item_name ?? '', it.quantity)
    }
    db.query('DELETE FROM storage_ships WHERE profile_id = ? AND station_id = ?').run(profileId, stationId)
    const insShip = db.query(`INSERT INTO storage_ships (profile_id, station_id, ship_id, class, custom_name, module_count)
      VALUES (?, ?, ?, ?, ?, ?)`)
    for (const s of ships) {
      if (!s.ship_id) continue
      insShip.run(profileId, stationId, s.ship_id, s.class ?? '', s.custom_name ?? '', s.module_count ?? 0)
    }
  })
  tx()
}

/** Everything one agent holds, newest-read first. Omit stationId for all stations. */
export function getStorageForProfile(profileId: string, stationId?: string): StorageRow[] {
  const sql = stationId
    ? 'SELECT * FROM storage_inventory WHERE profile_id = ? AND station_id = ? ORDER BY station_id, item_id'
    : 'SELECT * FROM storage_inventory WHERE profile_id = ? ORDER BY station_id, item_id'
  const args = stationId ? [profileId, stationId] : [profileId]
  return db.query(sql).all(...args) as StorageRow[]
}

/**
 * Replace one agent's ship hold. Like the storage snapshot this REPLACES rather
 * than merges — an item absent from a fresh read has been sold, deposited or
 * spent, and merging would resurrect it forever.
 */
export function recordCargoSnapshot(profileId: string, items: StorageItem[], shipId = ''): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM cargo_inventory WHERE profile_id = ?').run(profileId)
    const ins = db.query(`INSERT INTO cargo_inventory (profile_id, item_id, item_name, quantity, ship_id)
      VALUES (?, ?, ?, ?, ?)`)
    for (const it of items) {
      if (!it.item_id || !(it.quantity > 0)) continue
      ins.run(profileId, it.item_id, it.item_name ?? '', it.quantity, shipId)
    }
  })
  tx()
}

export interface ActionEvent {
  event_id: number
  created_at: string
  category: string
  event_type: string
  data: Record<string, unknown>
}

/**
 * Insert events idempotently (PK collision = already seen).
 *
 * Returns the event_ids that were genuinely NEW. Callers apply ledger deltas from
 * this list and nothing else — deriving "which were new" from a count and array
 * order silently double-counts the moment the feed returns anything out of order.
 */
export function recordActionEvents(profileId: string, category: string, events: ActionEvent[]): number[] {
  const inserted: number[] = []
  const tx = db.transaction(() => {
    const ins = db.query(`INSERT OR IGNORE INTO action_events
      (profile_id, event_id, created_at, category, event_type, data) VALUES (?, ?, ?, ?, ?, ?)`)
    let maxId = 0
    for (const e of events) {
      if (!Number.isFinite(e.event_id)) continue
      const r = ins.run(profileId, e.event_id, e.created_at ?? '', category,
        e.event_type ?? '?', JSON.stringify(e.data ?? {}))
      if (r.changes > 0) inserted.push(e.event_id)
      if (e.event_id > maxId) maxId = e.event_id
    }
    if (maxId > 0) {
      db.query(`INSERT INTO action_cursor (profile_id, category, last_event_id) VALUES (?, ?, ?)
        ON CONFLICT(profile_id, category) DO UPDATE SET
          last_event_id = MAX(last_event_id, excluded.last_event_id), updated_at = datetime('now')`)
        .run(profileId, category, maxId)
    }
  })
  tx()
  return inserted
}

export function getActionCursor(profileId: string, category: string): number {
  const r = db.query('SELECT last_event_id FROM action_cursor WHERE profile_id = ? AND category = ?')
    .get(profileId, category) as { last_event_id?: number } | undefined
  return r?.last_event_id ?? 0
}

/** Events for one agent after a timestamp, oldest first — the snapshot overlay. */
export function getEventsSince(profileId: string, sinceIso: string): ActionEvent[] {
  const rows = db.query(`SELECT event_id, created_at, category, event_type, data
    FROM action_events WHERE profile_id = ? AND created_at > ? ORDER BY event_id ASC`)
    .all(profileId, sinceIso) as Array<Record<string, string | number>>
  return rows.map(r => ({
    event_id: Number(r.event_id), created_at: String(r.created_at),
    category: String(r.category), event_type: String(r.event_type),
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
  }))
}

export function markStorageDirty(profileId: string, reason: string): void {
  db.query(`INSERT INTO storage_dirty (profile_id, reason) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET reason = excluded.reason`).run(profileId, reason)
}

export function clearStorageDirty(profileId: string): void {
  db.query('DELETE FROM storage_dirty WHERE profile_id = ?').run(profileId)
}

/**
 * Where has the fleet seen this resource? Richest first.
 *
 * The query that did not exist: agents re-flew to rediscover deposits because
 * nothing indexed what they had already surveyed.
 */
export function findDeposits(itemId: string, limit = 25): Array<Record<string, unknown>> {
  return db.query(`SELECT * FROM fleet_intel_deposits
    WHERE item_id = ? AND remaining > 0
    ORDER BY remaining DESC, richness DESC LIMIT ?`).all(itemId, limit) as Array<Record<string, unknown>>
}

/** Everything known about one POI. */
export function getPoiDeposits(poiId: string): Array<Record<string, unknown>> {
  return db.query('SELECT * FROM fleet_intel_deposits WHERE poi_id = ? ORDER BY remaining DESC')
    .all(poiId) as Array<Record<string, unknown>>
}

/** Coverage summary — how much of the galaxy we have actually surveyed. */
export function depositStats(): Record<string, unknown> {
  const row = db.query(`SELECT COUNT(*) AS records, COUNT(DISTINCT poi_id) AS pois,
    COUNT(DISTINCT item_id) AS items, COUNT(DISTINCT system_id) AS systems,
    MAX(last_seen) AS newest FROM fleet_intel_deposits`).get() as Record<string, unknown>
  const top = db.query(`SELECT item_id, COUNT(*) AS pois, SUM(remaining) AS total
    FROM fleet_intel_deposits WHERE remaining > 0
    GROUP BY item_id ORDER BY total DESC LIMIT 15`).all()
  return { ...row, top_items: top }
}

export function getStorageDirty(): Array<{ profile_id: string; reason: string; since: string }> {
  return db.query('SELECT * FROM storage_dirty').all() as
    Array<{ profile_id: string; reason: string; since: string }>
}

/** Item-movement history for one item, newest first — "where did it all go". */
export function getItemHistory(itemId: string, limit = 60): Array<Record<string, unknown>> {
  return db.query(`SELECT profile_id, created_at, event_type, data FROM action_events
    WHERE data LIKE ? ORDER BY event_id DESC LIMIT ?`)
    .all(`%"${itemId}"%`, limit) as Array<Record<string, unknown>>
}

/** What one agent is currently carrying. */
export function getCargoForProfile(profileId: string): StorageRow[] {
  return db.query(`SELECT profile_id, '(cargo)' AS station_id, item_id, item_name, quantity, updated_at
    FROM cargo_inventory WHERE profile_id = ? ORDER BY item_id`).all(profileId) as StorageRow[]
}

/**
 * Who in the fleet holds this item, and where — station storage AND ship holds.
 *
 * `station_id` is '(cargo)' for a ship hold. Callers that care whether an item is
 * actually usable must check this: crafting and supply_commission pull only from
 * the acting agent's own storage at that one station, so a fleet-wide total is
 * not the same as an actionable quantity.
 */
export function findItemAcrossFleet(itemId: string): StorageRow[] {
  return db.query(`
    SELECT profile_id, station_id, item_id, item_name, quantity, updated_at
      FROM storage_inventory WHERE item_id = ? AND quantity > 0
    UNION ALL
    SELECT profile_id, '(cargo)' AS station_id, item_id, item_name, quantity, updated_at
      FROM cargo_inventory WHERE item_id = ? AND quantity > 0
    ORDER BY quantity DESC`).all(itemId, itemId) as StorageRow[]
}

/** Fleet-wide total per item across every agent, station and ship hold. */
export function getFleetItemTotals(): Array<{
  item_id: string; total: number; locations: number; in_cargo: number
}> {
  return db.query(`
    SELECT item_id,
           SUM(quantity)                       AS total,
           COUNT(*)                            AS locations,
           SUM(CASE WHEN src = 'cargo' THEN quantity ELSE 0 END) AS in_cargo
      FROM (
        SELECT item_id, quantity, 'store' AS src FROM storage_inventory WHERE quantity > 0
        UNION ALL
        SELECT item_id, quantity, 'cargo' AS src FROM cargo_inventory   WHERE quantity > 0
      )
     GROUP BY item_id ORDER BY total DESC`)
    .all() as Array<{ item_id: string; total: number; locations: number; in_cargo: number }>
}

export function getStorageShips(profileId?: string): Array<Record<string, unknown>> {
  const sql = profileId
    ? 'SELECT * FROM storage_ships WHERE profile_id = ? ORDER BY station_id'
    : 'SELECT * FROM storage_ships ORDER BY profile_id, station_id'
  return (profileId ? db.query(sql).all(profileId) : db.query(sql).all()) as Array<Record<string, unknown>>
}

export function setSellQuota(profileId: string, itemId: string, remaining: number): void {
  db.query(`INSERT INTO sell_quotas (profile_id, item_id, remaining) VALUES (?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET remaining = excluded.remaining, updated_at = datetime('now')`)
    .run(profileId, itemId, remaining)
}

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
  const db = getDb()
  // Dedup idle runs: if the most-recent snapshot for this profile already has the
  // identical wallet+storage, skip the insert. Every real BALANCE CHANGE still lands
  // a row (the next differing value inserts); only consecutive identical idle samples
  // are collapsed, keeping the wealth-over-time series faithful while bounding growth.
  const last = db.query(
    'SELECT wallet, storage FROM financial_snapshots WHERE profile_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1'
  ).get(profileId) as { wallet: number; storage: number } | undefined
  if (last && last.wallet === wallet && last.storage === storage) return
  db.query(
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
