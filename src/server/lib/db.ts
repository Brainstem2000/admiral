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
      -- Units resting AT the best price. A price without a quantity is not a
      -- valuation. NULL = never captured; 0 = the game reported no orders.
      best_buy_qty INTEGER,
      best_sell_qty INTEGER,
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

    -- Crafting facilities and WHERE they are. The fleet has no other record of this, and
    -- it cost us repeatedly on 2026-08-20: the Thorium Roaster, Legend's Anvil, Heavy
    -- Railgun Assembly, Enhanced Driver Workshop and Lithium Cell Foundry were each found
    -- by accident, from the text of a no_facility error, after agents had already flown
    -- to the wrong station. Two free sources feed this:
    --   * facility_list -- everything at the station you are docked at
    --   * the no_facility error itself, which names the nearest public site
    --     ("Forge Adamantite is made in a Legend's Anvil ... Nearest public one: The
    --      Obsidian Well in Arneb (6 jump(s) away)")
    -- The owned column marks facilities the fleet built and pays upkeep on, so they are
    -- never confused with public ones we merely have access to.
    CREATE TABLE IF NOT EXISTS fleet_intel_facilities (
      station_id TEXT NOT NULL,
      facility_type TEXT NOT NULL,
      facility_name TEXT,
      station_name TEXT,
      system_name TEXT,
      recipe_id TEXT,
      public INTEGER DEFAULT 1,
      owned INTEGER DEFAULT 0,
      owner_profile_id TEXT,
      status TEXT,
      maintenance TEXT,
      build_cost INTEGER,
      notes TEXT,
      reported_by TEXT NOT NULL,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (station_id, facility_type)
    );
    CREATE INDEX IF NOT EXISTS idx_fifac_type ON fleet_intel_facilities(facility_type);
    CREATE INDEX IF NOT EXISTS idx_fifac_owned ON fleet_intel_facilities(owned);
    CREATE INDEX IF NOT EXISTS idx_fifac_recipe ON fleet_intel_facilities(recipe_id);

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
  // What the live commission_quote says the ship needs, item by item. The BoM guard
  // reads this rather than a hardcoded list, so it tracks the real order instead of
  // drifting: quantities change as lines are delivered and the quote is re-pulled.
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_requirements (
      ship_class TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ship_class, item_id)
    );
  `)

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

    -- Standing financial drains: facility rents and taxes, folded from the action
    -- log's 'other' category. Added 2026-08-21 after a Crew Bunk + Ledger Desk at
    -- confederacy_central_command turned out to have been billing one agent since
    -- 2026-07-22 — the rent ESCALATED 15cr -> 433cr per cycle and had consumed
    -- on the order of 2M credits before anyone noticed, because the ingestion
    -- swept only item-moving categories and rent fires while agents are offline.
    -- One row per (agent, station, facility) for rent; one per (agent, empire,
    -- tax type) for taxes. status flips to 'ended' on facility_dismantle.
    CREATE TABLE IF NOT EXISTS recurring_obligations (
      profile_id TEXT NOT NULL,
      obligation_type TEXT NOT NULL,          -- 'rent' | 'tax'
      station_id TEXT NOT NULL DEFAULT '',    -- empire name for taxes
      facility TEXT NOT NULL DEFAULT '',      -- tax type for taxes
      last_cost INTEGER NOT NULL DEFAULT 0,
      payment_count INTEGER NOT NULL DEFAULT 0,
      total_paid INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT '',
      last_seen TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (profile_id, obligation_type, station_id, facility),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    -- ===== SELF-ACCOUNTING LAYER (2026-08-21) =====
    -- None of these tables are pruned. Each exists because its absence cost something real:
    -- LLM spend lived in log_entries (14-day prune) so the fleet's core economics kept being
    -- recomputed by hand and lost; "is the Wagon insured?" needed live queries; empire tax
    -- rates float dev-side with no history; storage_ships went stale enough that scrap
    -- commands fired on phantom ids; freight P&L had no home; a 33k/night rent leak was
    -- caught only by an accidental wallet comparison.

    CREATE TABLE IF NOT EXISTS llm_spend_daily (
      profile_id TEXT NOT NULL,
      day TEXT NOT NULL,                      -- UTC YYYY-MM-DD
      model TEXT NOT NULL DEFAULT '',
      calls INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, day, model)
    );

    CREATE TABLE IF NOT EXISTS insurance_policies (
      policy_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      ship_class TEXT NOT NULL DEFAULT '',
      base_id TEXT NOT NULL DEFAULT '',
      coverage INTEGER NOT NULL DEFAULT 0,
      premium INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS empire_policy_snapshots (
      empire TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      property_rate TEXT NOT NULL DEFAULT '',
      income_rate TEXT NOT NULL DEFAULT '',
      sales_citizen_rate TEXT NOT NULL DEFAULT '',
      eviction_grace_cycles INTEGER NOT NULL DEFAULT 0,
      fuel_tax INTEGER NOT NULL DEFAULT 0,
      raw TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (empire, fetched_at)
    );

    -- Fitted modules of a profile's ACTIVE ship, replaced on every get_ship capture.
    CREATE TABLE IF NOT EXISTS ship_modules (
      profile_id TEXT NOT NULL,
      ship_id TEXT NOT NULL,
      module_name TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT '',
      cpu INTEGER NOT NULL DEFAULT 0,
      power INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, ship_id, module_name, slot)
    );

    CREATE TABLE IF NOT EXISTS freight_contracts (
      contract_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      origin_base TEXT NOT NULL DEFAULT '',
      dest_base TEXT NOT NULL DEFAULT '',
      base_reward INTEGER NOT NULL DEFAULT 0,
      appraised_value INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',    -- open | accepted | delivered | breached
      accepted_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wallet_daily (
      profile_id TEXT NOT NULL,
      day TEXT NOT NULL,                      -- UTC YYYY-MM-DD
      close_balance INTEGER NOT NULL DEFAULT 0,
      min_balance INTEGER NOT NULL DEFAULT 0,
      max_balance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, day)
    );

    -- Learned jump-graph edges. The galaxy_map blob only carries connections for VISITED
    -- systems (435 of 505 had none), so fleet BFS said horizon->krynn = 30 jumps where the
    -- game's own router flew it in 12 — routes and ferry economics computed on the blob
    -- were off by up to 2-3x. Every jump result carries the arrival system's complete
    -- connections list and every find_route result carries its route array; this table
    -- banks them permanently. Stored as canonical pairs (a < b): the game's links are
    -- bidirectional. Never pruned — a jump lane does not expire.
    CREATE TABLE IF NOT EXISTS system_links (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',        -- 'map_seed' | 'jump' | 'find_route' | 'get_system'
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (a, b)
    );

    -- Daily danger-grade snapshots per system, so danger TRENDS are visible even though
    -- the raw evidence (wrecks/killzones/sightings) prunes at 7 days. Grades: SAFE, RISKY,
    -- DANGEROUS ("only go if you are strapped"), FORBIDDEN (fleet ban — never). Written on
    -- assessment, keeping the WORST grade seen that day. Never pruned.
    CREATE TABLE IF NOT EXISTS system_danger_daily (
      system_id TEXT NOT NULL,
      day TEXT NOT NULL,
      grade TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (system_id, day)
    );

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

  // Migrate fleet_intel_market: record ORDER DEPTH alongside price.
  // The table stored what things cost and discarded how many were wanted at that price,
  // which made every valuation built on it wrong. Valuing the fleet's non-BoM stock at
  // price x holdings on 2026-08-20 gave 4,394,759; capping each line by real bid depth
  // gave 1,565,224 -- a 2.8x overstatement. Depth varies enormously and is not
  // guessable: shield_emitter was 112 units deep at 7,530 the same afternoon that
  // crimson_berserker_plating was ONE unit deep (14,956 for the first, 8,000 for the next).
  // Kept NULLABLE, with no DEFAULT, so "never captured" (NULL) stays distinct from "no
  // orders on that side" (0) -- realisableValue() treats the two very differently.
  const fimCols = db.query("PRAGMA table_info(fleet_intel_market)").all() as { name: string }[]
  if (!fimCols.some(c => c.name === 'best_buy_qty')) {
    db.exec('ALTER TABLE fleet_intel_market ADD COLUMN best_buy_qty INTEGER')
  }
  if (!fimCols.some(c => c.name === 'best_sell_qty')) {
    db.exec('ALTER TABLE fleet_intel_market ADD COLUMN best_sell_qty INTEGER')
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

/**
 * Replace the recorded requirement for one ship class from a fresh commission_quote.
 * Whole-set replace, not merge: a line that vanishes from the quote is no longer required,
 * and a stale row would keep protecting material the ship does not need.
 */
export function setCommissionRequirements(shipClass: string, items: Array<{ item_id: string; quantity: number }>): void {
  const tx = db.transaction((rows: Array<{ item_id: string; quantity: number }>) => {
    db.query('DELETE FROM commission_requirements WHERE ship_class = ?').run(shipClass)
    const ins = db.query(
      'INSERT INTO commission_requirements (ship_class, item_id, quantity) VALUES (?, ?, ?)',
    )
    for (const r of rows) {
      if (!r?.item_id || !Number.isFinite(r.quantity)) continue
      ins.run(shipClass, String(r.item_id).toLowerCase(), Math.max(0, Math.floor(r.quantity)))
    }
  })
  tx(items)
}

/** How many of this item the commission needs, across every recorded ship class. */
export function getCommissionRequirement(itemId: string): number {
  const row = db.query(
    'SELECT MAX(quantity) AS q FROM commission_requirements WHERE item_id = ?',
  ).get(String(itemId).toLowerCase()) as { q: number | null } | null
  return row?.q ?? 0
}

export function listCommissionRequirements(shipClass?: string): Array<{ ship_class: string; item_id: string; quantity: number; updated_at: string }> {
  const sql = shipClass
    ? 'SELECT * FROM commission_requirements WHERE ship_class = ? ORDER BY item_id'
    : 'SELECT * FROM commission_requirements ORDER BY ship_class, item_id'
  return (shipClass ? db.query(sql).all(shipClass) : db.query(sql).all()) as Array<{ ship_class: string; item_id: string; quantity: number; updated_at: string }>
}

/** What this agent holds of one item at one station — the number the craft guard protects. */
export function getStorageQuantity(profileId: string, stationId: string, itemId: string): number {
  const row = db.query(
    'SELECT quantity FROM storage_inventory WHERE profile_id = ? AND station_id = ? AND item_id = ?',
  ).get(profileId, stationId, itemId) as { quantity: number } | null
  return row?.quantity ?? 0
}

/** Everything this agent holds of one item, across every station. */
export function getStorageTotalForProfile(profileId: string, itemId: string): number {
  const row = db.query(
    'SELECT SUM(quantity) AS q FROM storage_inventory WHERE profile_id = ? AND item_id = ?',
  ).get(profileId, itemId) as { q: number | null } | null
  return row?.q ?? 0
}

/**
 * The station this agent most recently recorded storage at — our best available proxy for
 * "where they are standing" inside a guard that is not given location context.
 * Storage snapshots are written on every view_storage, so this tracks closely in practice.
 */
export function getMostRecentStation(profileId: string): string | null {
  const row = db.query(
    'SELECT station_id FROM storage_inventory WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(profileId) as { station_id: string } | null
  return row?.station_id ?? null
}

/** Fleet-wide holdings of an item outside one station — where to source a blocked craft from. */
export function getStorageElsewhere(stationId: string, itemId: string): Array<{ profile_id: string; station_id: string; quantity: number }> {
  return db.query(
    `SELECT profile_id, station_id, quantity FROM storage_inventory
     WHERE item_id = ? AND station_id != ? AND quantity > 0
     ORDER BY quantity DESC LIMIT 5`,
  ).all(itemId, stationId) as Array<{ profile_id: string; station_id: string; quantity: number }>
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

/**
 * Fold financial drain events into the obligations register. Unlike cargo, this IS
 * replayed on backfill — a rent paid in July is still money gone, and the whole point
 * of the register is that history a human never watched still adds up somewhere.
 * INSERT OR IGNORE on action_events already guarantees each event folds exactly once.
 */
export function recordObligations(profileId: string, events: ActionEvent[]): void {
  const rent = db.query(`
    INSERT INTO recurring_obligations
      (profile_id, obligation_type, station_id, facility, last_cost, payment_count, total_paid, first_seen, last_seen)
    VALUES (?, 'rent', ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(profile_id, obligation_type, station_id, facility) DO UPDATE SET
      last_cost = excluded.last_cost,
      payment_count = payment_count + 1,
      total_paid = total_paid + excluded.total_paid,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen),
      status = 'active'`)
  const tax = db.query(`
    INSERT INTO recurring_obligations
      (profile_id, obligation_type, station_id, facility, last_cost, payment_count, total_paid, first_seen, last_seen)
    VALUES (?, 'tax', ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(profile_id, obligation_type, station_id, facility) DO UPDATE SET
      last_cost = excluded.last_cost,
      payment_count = payment_count + 1,
      total_paid = total_paid + excluded.total_paid,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen)`)
  const ended = db.query(`
    UPDATE recurring_obligations SET status = 'ended', last_seen = MAX(last_seen, ?)
    WHERE profile_id = ? AND obligation_type = 'rent' AND station_id = ? AND facility = ?`)
  const tx = db.transaction(() => {
    for (const e of events) {
      const d = e.data ?? {}
      const when = e.created_at ?? ''
      if (e.event_type === 'other.rent_paid') {
        const cost = Number(d.cost ?? 0) || 0
        rent.run(profileId, String(d.base_id ?? ''), String(d.facility ?? ''), cost, cost, when, when)
      } else if (e.event_type === 'tax.property_paid' || e.event_type === 'tax.income_paid') {
        const paid = Number(d.paid ?? d.owed ?? 0) || 0
        tax.run(profileId, String(d.empire ?? ''), e.event_type.replace('tax.', ''), paid, paid, when, when)
      } else if (e.event_type === 'other.facility_dismantle_completed') {
        ended.run(when, profileId, String(d.base_id ?? ''), String(d.facility ?? ''))
      }
    }
  })
  tx()
}

export interface ObligationRow {
  profile_id: string; obligation_type: string; station_id: string; facility: string
  last_cost: number; payment_count: number; total_paid: number
  first_seen: string; last_seen: string; status: string
}

/** Active-first, biggest drain first. `activeWithinHours` treats a rent silent longer than that as lapsed. */
export function listObligations(profileId?: string): ObligationRow[] {
  const where = profileId ? 'WHERE profile_id = ?' : ''
  const q = db.query(`SELECT * FROM recurring_obligations ${where}
    ORDER BY status = 'active' DESC, total_paid DESC`)
  return (profileId ? q.all(profileId) : q.all()) as ObligationRow[]
}

// ===== self-accounting helpers (2026-08-21) =====

/** Fold one LLM call into the durable daily rollup. Called at the same site that logs llm_call. */
export function recordLlmSpend(profileId: string, model: string, cost: number,
  inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number): void {
  const day = new Date().toISOString().slice(0, 10)
  db.query(`INSERT INTO llm_spend_daily (profile_id, day, model, calls, cost, input_tokens, output_tokens, cache_read, cache_write)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, day, model) DO UPDATE SET
      calls = calls + 1, cost = cost + excluded.cost,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write`)
    .run(profileId, day, model, cost, inputTokens, outputTokens, cacheRead, cacheWrite)
}

/** Replace the recorded ACTIVE policy set for one agent from a `policies` result. */
export function replaceInsurancePolicies(profileId: string, policies: Array<{
  policy_id?: string; ship_class?: string; base_id?: string; coverage?: number; premium?: number; expires_at?: string
}>): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM insurance_policies WHERE profile_id = ?').run(profileId)
    const ins = db.query(`INSERT OR REPLACE INTO insurance_policies
      (policy_id, profile_id, ship_class, base_id, coverage, premium, expires_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    for (const p of policies) {
      if (!p.policy_id) continue
      ins.run(p.policy_id, profileId, p.ship_class ?? '', p.base_id ?? '',
        Number(p.coverage ?? 0) || 0, Number(p.premium ?? 0) || 0, p.expires_at ?? '')
    }
  })
  tx()
}

/** Snapshot one empire's policy block, parsed from get_empire_info text. */
export function recordEmpirePolicy(empire: string, parsed: {
  property?: string; income?: string; salesCitizen?: string; evictionGrace?: number; fuelTax?: number
}, raw: string): void {
  db.query(`INSERT OR REPLACE INTO empire_policy_snapshots
    (empire, fetched_at, property_rate, income_rate, sales_citizen_rate, eviction_grace_cycles, fuel_tax, raw)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`)
    .run(empire, parsed.property ?? '', parsed.income ?? '', parsed.salesCitizen ?? '',
      parsed.evictionGrace ?? 0, parsed.fuelTax ?? 0, raw.slice(0, 4000))
}

/** Replace one agent's ship registry from a live list_ships result — the cure for phantom ship_ids. */
export function replaceShipsForProfile(profileId: string, ships: Array<{
  ship_id?: string; class_id?: string; location_base_id?: string; is_active?: boolean; modules?: number; custom_name?: string
}>): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM storage_ships WHERE profile_id = ?').run(profileId)
    const ins = db.query(`INSERT OR REPLACE INTO storage_ships
      (profile_id, station_id, ship_id, class, custom_name, module_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    for (const s of ships) {
      if (!s.ship_id) continue
      ins.run(profileId, s.is_active ? '__active__' : (s.location_base_id ?? ''),
        s.ship_id, s.class_id ?? '', s.custom_name ?? '', Number(s.modules ?? 0) || 0)
    }
  })
  tx()
}

/** Replace the fitted-module manifest for a profile's active ship from a get_ship result. */
export function recordShipModules(profileId: string, shipId: string, modules: Array<{
  name?: string; slot?: string; cpu_usage?: number; power_usage?: number
}>): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM ship_modules WHERE profile_id = ?').run(profileId)
    const ins = db.query(`INSERT OR REPLACE INTO ship_modules
      (profile_id, ship_id, module_name, slot, cpu, power, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    for (const m of modules) {
      if (!m.name) continue
      ins.run(profileId, shipId, m.name, m.slot ?? '', Number(m.cpu_usage ?? 0) || 0, Number(m.power_usage ?? 0) || 0)
    }
  })
  tx()
}

/** Upsert freight contracts from any shipping list/accept/complete result. Status only moves forward. */
export function upsertFreightContracts(profileId: string, rows: Array<{
  contract_id?: string; id?: string; origin_base?: string; dest_base?: string; destination_base_id?: string
  base_reward?: number; appraised_value?: number; status?: string; accepted_at?: string; completed_at?: string
}>): void {
  const rank: Record<string, number> = { open: 0, accepted: 1, delivered: 2, breached: 2 }
  const tx = db.transaction(() => {
    for (const r of rows) {
      const id = r.contract_id ?? r.id
      if (!id) continue
      const status = r.status ?? 'open'
      const existing = db.query('SELECT status FROM freight_contracts WHERE contract_id = ?').get(id) as { status: string } | undefined
      const keep = existing && (rank[existing.status] ?? 0) > (rank[status] ?? 0) ? existing.status : status
      db.query(`INSERT INTO freight_contracts
        (contract_id, profile_id, origin_base, dest_base, base_reward, appraised_value, status, accepted_at, completed_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(contract_id) DO UPDATE SET
          status = ?, completed_at = MAX(completed_at, excluded.completed_at), last_seen = datetime('now')`)
        .run(id, profileId, r.origin_base ?? '', r.dest_base ?? r.destination_base_id ?? '',
          Number(r.base_reward ?? 0) || 0, Number(r.appraised_value ?? 0) || 0,
          keep, r.accepted_at ?? '', r.completed_at ?? '', keep)
    }
  })
  tx()
}

/** Bank learned jump-graph edges as canonical pairs. Cheap enough to call on every capture. */
export function recordSystemLinks(pairs: Array<[string, string]>, source: string): void {
  if (!pairs.length) return
  const ins = db.query(`INSERT INTO system_links (a, b, source) VALUES (?, ?, ?)
    ON CONFLICT(a, b) DO UPDATE SET last_seen = datetime('now')`)
  const tx = db.transaction(() => {
    for (const [x, y] of pairs) {
      const a = String(x).toLowerCase().trim(), b = String(y).toLowerCase().trim()
      if (!a || !b || a === b) continue
      ins.run(a < b ? a : b, a < b ? b : a, source)
    }
  })
  tx()
}

/** The full learned adjacency — union this with the galaxy_map blob when routing. */
export function getKnownLinks(): Array<{ a: string; b: string }> {
  return db.query('SELECT a, b FROM system_links').all() as Array<{ a: string; b: string }>
}

/** Fleet hard bans — systems no route may cross, whatever the evidence says today. */
export const FORBIDDEN_SYSTEMS = new Set(['goldcrest', 'bluerift'])

const GRADE_RANK: Record<string, number> = { SAFE: 0, RISKY: 1, DANGEROUS: 2, FORBIDDEN: 3 }

/**
 * Grade one system from live evidence. Calibrated 2026-08-21 against real data:
 * police_level runs 0–100 (57 known systems sit at ZERO police; 397 are unvisited/unknown),
 * wreck_type 'ship' means a vessel was destroyed there, killzones carry last_pirate_at.
 * Unknown space is graded RISKY, not SAFE — absence of evidence is not policing.
 */
export function assessSystemDanger(systemId: string): { grade: string; reasons: string[] } {
  const id = String(systemId).toLowerCase().trim()
  if (FORBIDDEN_SYSTEMS.has(id)) {
    return { grade: 'FORBIDDEN', reasons: ['fleet ban — losses recorded here (leviathan corridor)'] }
  }
  const reasons: string[] = []
  const sys = db.query('SELECT police_level FROM fleet_intel_systems WHERE system_id = ?')
    .get(id) as { police_level: number | null } | undefined
  let rank: number
  if (sys?.police_level == null) { rank = GRADE_RANK.RISKY; reasons.push('police level unknown (unvisited)') }
  else if (sys.police_level >= 55) { rank = GRADE_RANK.SAFE; reasons.push(`police ${sys.police_level}`) }
  else if (sys.police_level > 0) { rank = GRADE_RANK.RISKY; reasons.push(`low police (${sys.police_level})`) }
  else { rank = GRADE_RANK.DANGEROUS; reasons.push('ZERO police') }

  const shipWreck = db.query(`SELECT COUNT(*) n FROM fleet_intel_wrecks
    WHERE system_id = ? AND wreck_type = 'ship' AND last_seen > datetime('now','-72 hours')`)
    .get(id) as { n: number }
  if (shipWreck.n > 0) { rank = Math.max(rank, GRADE_RANK.DANGEROUS); reasons.push(`${shipWreck.n} ship wreck(s) <72h`) }

  const kz = db.query(`SELECT COUNT(*) n FROM fleet_intel_killzones
    WHERE system_id = ? AND pirate_seen = 1 AND last_pirate_at > datetime('now','-7 days')`)
    .get(id) as { n: number }
  if (kz.n > 0) { rank = Math.min(rank + 1, GRADE_RANK.DANGEROUS); reasons.push('pirates seen <7d') }

  const grade = (Object.keys(GRADE_RANK) as string[]).find((g) => GRADE_RANK[g] === rank) ?? 'RISKY'
  // Trend snapshot: keep the WORST grade seen each day, so improvement/decay is visible
  // long after the raw evidence prunes.
  try {
    db.query(`INSERT INTO system_danger_daily (system_id, day, grade, evidence)
      VALUES (?, date('now'), ?, ?)
      ON CONFLICT(system_id, day) DO UPDATE SET
        grade = CASE WHEN
          (CASE excluded.grade WHEN 'SAFE' THEN 0 WHEN 'RISKY' THEN 1 WHEN 'DANGEROUS' THEN 2 ELSE 3 END) >
          (CASE grade WHEN 'SAFE' THEN 0 WHEN 'RISKY' THEN 1 WHEN 'DANGEROUS' THEN 2 ELSE 3 END)
        THEN excluded.grade ELSE grade END,
        evidence = excluded.evidence`)
      .run(id, grade, reasons.join('; '))
  } catch { /* snapshot must never break an assessment */ }
  return { grade, reasons }
}

/** Fold a wallet reading into the never-pruned daily min/max/close. Piggybacks the snapshot writer. */
export function touchWalletDaily(profileId: string, balance: number): void {
  if (!Number.isFinite(balance)) return
  const day = new Date().toISOString().slice(0, 10)
  db.query(`INSERT INTO wallet_daily (profile_id, day, close_balance, min_balance, max_balance)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, day) DO UPDATE SET
      close_balance = excluded.close_balance,
      min_balance = MIN(min_balance, excluded.min_balance),
      max_balance = MAX(max_balance, excluded.max_balance)`)
    .run(profileId, day, balance, balance, balance)
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

export interface RealisableValue {
  item_id: string
  held: number
  /** Station whose bid realises the most for `held` units, or null if nobody is bidding. */
  station_id: string | null
  station_name: string | null
  system_name: string | null
  /** Best bid at that station. */
  price: number | null
  /** Units bid for AT that price. null means never captured -- NOT zero. */
  depth: number | null
  /** Units actually sellable into that bid: min(held, depth). */
  units: number
  /** units * price -- what the stack is really worth. */
  value: number
  /** false => depth unknown, so `value` is an UPPER BOUND (the old price x holdings figure). */
  depth_known: boolean
  updated_at: string | null
}

/**
 * What `heldQty` of an item would actually fetch, capped by real bid depth.
 *
 * `price * holdings` is not a valuation -- it assumes someone is bidding for every unit
 * at the top price, and usually nobody is. Use this instead of multiplying.
 *
 * Picks the station where the stack realises the MOST, which is not always the one with
 * the highest headline price: a 112-deep bid at 7,530 beats a one-unit bid at 14,956.
 * Rows whose depth was never captured are only ever used as a last resort, because their
 * uncapped figure would otherwise outbid every honest one -- when that happens the result
 * carries `depth_known: false` and the caller must treat `value` as a ceiling, not a price.
 */
export function realisableValue(itemId: string, heldQty: number): RealisableValue {
  const held = Math.max(0, Math.floor(heldQty))
  const none: RealisableValue = {
    item_id: itemId, held, station_id: null, station_name: null, system_name: null,
    price: null, depth: null, units: 0, value: 0, depth_known: false, updated_at: null,
  }
  if (held === 0) return none

  const rows = getDb().query(`
    SELECT station_id, station_name, system_name, best_buy, best_buy_qty, updated_at
      FROM fleet_intel_market
     WHERE item_id = ? AND best_buy IS NOT NULL AND best_buy > 0`)
    .all(itemId) as Array<{
      station_id: string; station_name: string; system_name: string
      best_buy: number; best_buy_qty: number | null; updated_at: string
    }>

  let best: RealisableValue | null = null
  for (const r of rows) {
    const depthKnown = r.best_buy_qty !== null
    // A known depth of 0 means the bids are gone: the stack realises nothing here.
    const units = depthKnown ? Math.min(held, Math.max(0, r.best_buy_qty as number)) : held
    const cand: RealisableValue = {
      item_id: itemId, held,
      station_id: r.station_id, station_name: r.station_name, system_name: r.system_name,
      price: r.best_buy, depth: r.best_buy_qty, units, value: units * r.best_buy,
      depth_known: depthKnown, updated_at: r.updated_at,
    }
    // Verified depth always beats unverified, however big the unverified number looks.
    if (!best) { best = cand; continue }
    if (cand.depth_known !== best.depth_known) { if (cand.depth_known) best = cand; continue }
    if (cand.value > best.value) best = cand
  }
  return best ?? none
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

export interface SellQuotaRow { item_id: string; remaining: number; updated_at: string }

/** Every quota row for one agent, richest first — what the Admiral has released and what is left. */
export function listSellQuotas(profileId: string): SellQuotaRow[] {
  return db.query(
    'SELECT item_id, remaining, updated_at FROM sell_quotas WHERE profile_id = ? ORDER BY remaining DESC, item_id',
  ).all(profileId) as SellQuotaRow[]
}

/** Drop a quota row entirely. Absent and zero both block, so this is a tidy-up, not a lock. */
export function clearSellQuota(profileId: string, itemId: string): boolean {
  const res = db.query('DELETE FROM sell_quotas WHERE profile_id = ? AND item_id = ?')
    .run(profileId, itemId)
  return res.changes > 0
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
  // Daily close survives snapshot pruning — and runs BEFORE the idle dedupe below, or a
  // wallet static across midnight would never open the new day's row.
  try { touchWalletDaily(profileId, wallet) } catch { /* accounting never blocks a snapshot */ }
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
