import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile, reorderProfiles, listSellQuotas, setSellQuota, clearSellQuota, getLatestWallets, getProfileLastStates, saveAgentSnapshot, getAgentSnapshot } from '../lib/db'
import { buildSystemPrompt, buildVolatileState } from '../lib/agent'
import { fetchGameCommands, formatCommandList } from '../lib/schema'
import { agentManager } from '../lib/agent-manager'
import { resolveProfileModelRouting } from '../lib/model-routing'
import type { Profile } from '../../shared/types'

const profiles = new Hono()

// Never send the stored SpaceMolt password to the client. Expose has_password so
// the UI can indicate a password is set without leaking it.
function sanitizeProfile<T extends { password?: string | null }>(p: T): Omit<T, 'password'> & { has_password: boolean } {
  const { password, ...rest } = p
  return { ...rest, has_password: !!password }
}

/**
 * Surface the models actually driving the agent. `provider`/`model` are the
 * rollback baseline and stay untouched when a Codex overlay is active, so
 * reading them alone reports the wrong engine (observed: dashboard and the
 * fleet-watch script showing claude-max for Codex-routed agents). Attach the
 * resolved routing as `effective_*` fields — additive, so existing consumers
 * are unaffected.
 */
function withEffectiveRouting<T extends Record<string, unknown>>(p: T) {
  try {
    const routing = resolveProfileModelRouting(p as unknown as Profile)
    return {
      ...p,
      effective_provider: routing.executor.provider,
      effective_model: routing.executor.model,
      effective_planner_provider: routing.planner?.provider ?? null,
      effective_planner_model: routing.planner?.model ?? null,
      model_overlay: routing.executor.provider !== p.provider || (routing.planner ? routing.planner.provider !== (p.planner_provider ?? p.provider) : false),
    }
  } catch {
    // No baseline configured yet (profile mid-creation) — report as-is.
    return p
  }
}

const CONNECTION_MODES = new Set(['http', 'http_v2', 'websocket', 'mcp', 'mcp_v2', 'lib_v2'])

/**
 * Validate the numeric/enum fields that drive scheduler and LLM-loop logic.
 * Returns an error message, or null if the (present) fields are well-formed.
 * Absent fields are ignored so partial updates stay valid.
 */
function validateProfileInput(body: Record<string, unknown>): string | null {
  if (body.planning_interval != null) {
    const v = body.planning_interval
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      return 'planning_interval must be a positive integer'
    }
  }
  if (body.context_budget != null) {
    const v = body.context_budget
    if (typeof v !== 'number' || !(v > 0 && v <= 1)) {
      return 'context_budget must be a number between 0 and 1'
    }
  }
  if (body.connection_mode != null && !CONNECTION_MODES.has(body.connection_mode as string)) {
    return `connection_mode must be one of: ${[...CONNECTION_MODES].join(', ')}`
  }
  return null
}

// GET /api/profiles
profiles.get('/', (c) => {
  const all = listProfiles()
  // Durable last-known wallets + character sheets so offline cards and profile pages
  // show real state (with its age) instead of whatever gameState was cached at connect.
  const wallets = getLatestWallets()
  const lastStates = getProfileLastStates()
  return c.json(all.map(p => {
    const status = agentManager.getStatus(p.id)
    // Persist live faction name to group_name so it survives disconnects
    const liveFaction = (status.gameState as Record<string, unknown> | null)?.faction as string | undefined
    if (liveFaction && liveFaction !== p.group_name) {
      updateProfile(p.id, { group_name: liveFaction })
      p.group_name = liveFaction
    }
    const lw = wallets.get(p.id)
    return withEffectiveRouting(sanitizeProfile({
      ...p, ...status,
      last_wallet: lw?.wallet ?? null, last_wallet_at: lw?.at ?? null,
      last_state: lastStates.get(p.id) ?? null,
    }))
  }))
})

// POST /api/profiles
profiles.post('/', async (c) => {
  const body = await c.req.json()
  const { name, username, password, empire, provider, model, planner_provider, planner_model, planning_interval, directive, connection_mode, server_url, context_budget } = body
  if (!name) return c.json({ error: 'Name is required' }, 400)
  const inputError = validateProfileInput(body)
  if (inputError) return c.json({ error: inputError }, 400)
  try {
    const profile = createProfile({
      id: crypto.randomUUID(),
      name,
      username: username || null,
      password: password || null,
      empire: empire || '',
      player_id: null,
      provider: provider || null,
      model: model || null,
      planner_provider: planner_provider || null,
      planner_model: planner_model || null,
      planning_interval: planning_interval ?? null,
      codex_executor_enabled: false,
      codex_executor_model: null,
      codex_planner_enabled: false,
      codex_planner_model: null,
      directive: directive || '',
      todo: '',
      memory: '',
      context_budget: context_budget ?? null,
      connection_mode: connection_mode || 'http',
      server_url: server_url || 'https://game.spacemolt.com',
      autoconnect: true,
      enabled: true,
      sort_order: body.sort_order ?? listProfiles().length,
      group_name: body.group_name || '',
    })
    return c.json(sanitizeProfile(profile), 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint')) return c.json({ error: 'A profile with that name already exists' }, 409)
    return c.json({ error: msg }, 500)
  }
})

// PUT /api/profiles/reorder
profiles.put('/reorder', async (c) => {
  const body = await c.req.json()
  const ids = body.ids as string[]
  if (!Array.isArray(ids)) return c.json({ error: 'ids array required' }, 400)
  reorderProfiles(ids)
  return c.json({ ok: true })
})

// GET /api/profiles/:id
profiles.get('/:id', (c) => {
  const profile = getProfile(c.req.param('id'))
  if (!profile) return c.json({ error: 'Not found' }, 404)
  const status = agentManager.getStatus(c.req.param('id'))
  const ls = getProfileLastStates().get(profile.id) ?? null
  return c.json(withEffectiveRouting(sanitizeProfile({ ...profile, ...status, last_state: ls })))
})

// PUT /api/profiles/:id
profiles.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const inputError = validateProfileInput(body)
  if (inputError) return c.json({ error: inputError }, 400)
  // An empty/absent password means "keep the existing one" — the UI never
  // receives the stored password, so it cannot echo it back on save.
  if (body.password == null || body.password === '') delete body.password
  const profile = updateProfile(id, body)
  if (!profile) return c.json({ error: 'Not found' }, 404)
  if (body.directive !== undefined) agentManager.restartTurn(id)
  return c.json(sanitizeProfile(profile))
})

// DELETE /api/profiles/:id
profiles.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await agentManager.disconnect(id)
  deleteProfile(id)
  return c.json({ ok: true })
})

// POST /api/profiles/:id/connect
profiles.post('/:id/connect', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const action = (body as Record<string, unknown>).action as string || 'connect'
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  try {
    if (action === 'disconnect') {
      await agentManager.disconnect(id)
      return c.json({ connected: false, running: false })
    }
    await agentManager.connect(id)
    if (action === 'connect_llm' && profile.provider && profile.provider !== 'manual' && profile.model) {
      await agentManager.startLLM(id)
    }
    return c.json(agentManager.getStatus(id))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /api/profiles/:id/command
profiles.post('/:id/command', async (c) => {
  const id = c.req.param('id')
  const { command, args, silent, override } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    // `override: true` bypasses the Admiral doctrine guards for this one call
    // (operator escape hatch); it is logged on the agent's stream.
    const result = await agent.executeCommand(command, args, { silent: !!silent, override: !!override })
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/** Replay the last banked payload for a pane whose live read needs a connection.
 *  Returns 204 (not an error) when nothing was ever captured, so the UI can say
 *  "never seen" rather than rendering a failure. */
function replaySnapshot(c: Parameters<Parameters<typeof profiles.get>[1]>[0], id: string, kind: string) {
  const snap = getAgentSnapshot(id, kind)
  if (!snap) return c.json({ stale: true, never: true, error: 'No snapshot captured for this agent yet' }, 200)
  return c.json({ ...(snap.payload as object), stale: true, fetched_at: snap.fetched_at })
}

/** GET /api/profiles/:id/skills — live get_skills when connected, last known otherwise. */
profiles.get('/:id/skills', async (c) => {
  const id = c.req.param('id')
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return replaySnapshot(c, id, 'skills')
  try {
    const raw = await agent.executeCommand('get_skills', {}, { silent: true }) as Record<string, unknown>
    const sc = (raw.structuredContent ?? raw.result ?? raw) as Record<string, unknown>
    if (!sc?.skills || typeof sc.skills !== 'object') return replaySnapshot(c, id, 'skills')
    const payload = { skills: sc.skills, fetched_at: new Date().toISOString() }
    saveAgentSnapshot(id, 'skills', payload)
    return c.json({ ...payload, stale: false })
  } catch {
    return replaySnapshot(c, id, 'skills')
  }
})

/** GET /api/profiles/:id/combat-stats — live kill tallies + Empire skill,
 *  falling back to the last known reading for a parked agent. */
profiles.get('/:id/combat-stats', async (c) => {
  const id = c.req.param('id')
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return replaySnapshot(c, id, 'combat')
  try {
    // Mirrors what the Combat pane has always read: the kill tallies live on
    // player.stats from get_status, and the Empire skill comes from get_skills.
    const [statusRaw, skillsRaw] = await Promise.all([
      agent.executeCommand('get_status', {}, { silent: true }) as Promise<Record<string, unknown>>,
      (agent.executeCommand('get_skills', {}, { silent: true }) as Promise<Record<string, unknown>>).catch(() => null),
    ])
    const sc = (statusRaw.structuredContent ?? statusRaw.result ?? statusRaw) as Record<string, unknown>
    const stats = (sc.player as Record<string, unknown> | undefined)?.stats
    if (!stats || typeof stats !== 'object') return replaySnapshot(c, id, 'combat')

    const sk = (skillsRaw?.structuredContent ?? skillsRaw?.result) as Record<string, unknown> | undefined
    let empireSkill: unknown = null
    if (sk?.skills && typeof sk.skills === 'object') {
      empireSkill = Object.values(sk.skills as Record<string, { category?: string }>)
        .find((v) => v?.category === 'Empire') ?? null
    }
    const payload = { stats, empireSkill, fetched_at: new Date().toISOString() }
    saveAgentSnapshot(id, 'combat', payload)
    return c.json({ ...payload, stale: false })
  } catch {
    return replaySnapshot(c, id, 'combat')
  }
})

/**
 * GET /api/profiles/:id/ship-analysis — the Ship pane's data feed.
 *
 * One free get_ship query through the agent's connection, joined against the
 * local catalog: fitted modules with full stats, CPU/power budgets with
 * per-module draw, slot occupancy, and — the point — UPGRADE candidates per
 * slot: catalog modules that beat the fitted one and still fit the budget
 * after the swap, annotated with fleet-storage holdings and the freshest
 * fleet-intel ask so "upgradeable" is a fact, not a guess. Zero game ticks.
 */
profiles.get('/:id/ship-analysis', async (c) => {
  const id = c.req.param('id')
  const agent = agentManager.getAgent(id)
  // Offline agents replay the last good analysis. The pane used to go blank
  // here, which is backwards: a parked agent is exactly the one you are trying
  // to size up before waking it.
  if (!agent || !agent.isConnected) return replaySnapshot(c, id, 'ship')
  try {
    const { listModules, getItem, getShip } = await import('../lib/catalog')
    const { getDb } = await import('../lib/db')
    const raw = await agent.executeCommand('get_ship', {}, { silent: true }) as Record<string, unknown>
    const sc = (raw.structuredContent ?? raw.result ?? {}) as Record<string, unknown>
    const ship = (sc.ship ?? {}) as Record<string, unknown>
    const fitted = Array.isArray(sc.modules) ? sc.modules as Array<Record<string, unknown>> : []

    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const cpuFree = num(ship.cpu_capacity) - num(ship.cpu_used)
    const powerFree = num(ship.power_capacity) - num(ship.power_used)

    const db = getDb()
    const fleetHeld = (itemId: string) => {
      const r = db.query('SELECT SUM(quantity) q FROM storage_inventory WHERE item_id = ?').get(itemId) as { q: number | null } | undefined
      return Number(r?.q ?? 0)
    }
    const bestAsk = (itemId: string) => {
      const r = db.query(
        `SELECT station_id, best_sell, best_sell_qty, updated_at FROM fleet_intel_market
         WHERE item_id = ? AND best_sell IS NOT NULL AND best_sell > 0
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(itemId) as { station_id: string; best_sell: number; best_sell_qty: number | null; updated_at: string } | undefined
      return r ?? null
    }

    // Primary comparison stat per slot family. Weapons compare damage; other
    // slots have heterogeneous stats, so base_value orders them (tier proxy).
    const primaryStat = (m: Record<string, unknown>) =>
      String(m.slot) === 'weapon' ? num(m.damage) : num(m.base_value)

    const catalogMods = listModules()
    const annotate = (candidate: Record<string, unknown>) => {
      const cid = String(candidate.id)
      const ask = bestAsk(cid)
      return {
        id: cid,
        name: candidate.name,
        cpu_usage: num(candidate.cpu_usage),
        power_usage: num(candidate.power_usage),
        damage: candidate.damage ?? null,
        damage_type: candidate.damage_type ?? null,
        reach: candidate.reach ?? null,
        base_value: num(candidate.base_value),
        required_skills: candidate.required_skills ?? null,
        fleet_held: fleetHeld(cid),
        market: ask ? { station: ask.station_id, ask: ask.best_sell, depth: ask.best_sell_qty, seen: ask.updated_at } : null,
      }
    }

    const modulesOut = fitted.map((m) => {
      const slot = String(m.slot ?? '')
      const draw = { cpu: num(m.cpu_usage), power: num(m.power_usage) }
      // After unfitting this module, the budget the replacement must fit.
      const cpuRoom = cpuFree + draw.cpu
      const powerRoom = powerFree + draw.power
      const mine = primaryStat(m)
      const better = catalogMods
        .filter((cm) => String(cm.slot) === slot
          && primaryStat(cm as unknown as Record<string, unknown>) > mine
          && num(cm.cpu_usage) <= cpuRoom && num(cm.power_usage) <= powerRoom)
        .sort((a, b) => primaryStat(b as unknown as Record<string, unknown>) - primaryStat(a as unknown as Record<string, unknown>))
        .slice(0, 3)
        .map((cm) => annotate(cm as unknown as Record<string, unknown>))
      return { ...m, upgrades: better }
    })

    // Open slots: capacity minus fitted per family, with best fits for the
    // remaining (unswapped) budget.
    const slotCaps: Record<string, number> = {
      weapon: num(ship.weapon_slots), defense: num(ship.defense_slots), utility: num(ship.utility_slots),
    }
    const fittedCounts: Record<string, number> = {}
    for (const m of fitted) {
      const s = String(m.slot ?? '')
      fittedCounts[s] = (fittedCounts[s] ?? 0) + 1
    }
    const openSlots = Object.entries(slotCaps).map(([slot, cap]) => {
      const open = Math.max(0, cap - (fittedCounts[slot] ?? 0))
      if (!open) return { slot, open, suggestions: [] }
      const fits = catalogMods
        .filter((cm) => String(cm.slot) === slot && num(cm.cpu_usage) <= cpuFree && num(cm.power_usage) <= powerFree)
        .sort((a, b) => primaryStat(b as unknown as Record<string, unknown>) - primaryStat(a as unknown as Record<string, unknown>))
        .slice(0, 3)
        .map((cm) => annotate(cm as unknown as Record<string, unknown>))
      return { slot, open, suggestions: fits }
    })

    // Cargo manifest enriched with catalog size/value.
    let cargo = Array.isArray(ship.cargo) ? ship.cargo as Array<Record<string, unknown>> : []
    if (!cargo.length && num(ship.cargo_used) > 0) {
      const cargoRaw = await agent.executeCommand('get_cargo', {}, { silent: true }).catch(() => null) as Record<string, unknown> | null
      const cr = (cargoRaw?.structuredContent ?? cargoRaw?.result ?? {}) as Record<string, unknown>
      cargo = Array.isArray(cr.cargo) ? cr.cargo as Array<Record<string, unknown>> : []
    }
    const cargoOut = cargo.map((it) => {
      const item = getItem(String(it.item_id))
      return { ...it, size: item?.size ?? null, base_value: item?.base_value ?? null }
    })

    const hullInfo = getShip(String(ship.class_id ?? '')) ?? null
    const payload = {
      ship,
      hull_catalog: hullInfo ? {
        tier: hullInfo.tier, class: hullInfo.class, faction: hullInfo.faction,
        inherent_capabilities: (hullInfo as Record<string, unknown>).inherent_capabilities ?? null,
      } : null,
      budgets: { cpu_free: cpuFree, power_free: powerFree },
      modules: modulesOut,
      open_slots: openSlots,
      cargo: cargoOut,
      fetched_at: new Date().toISOString(),
    }
    saveAgentSnapshot(id, 'ship', payload)
    return c.json({ ...payload, stale: false })
  } catch (err) {
    // A live read that fails mid-flight (session expiry, timeout) should fall
    // back to the last good one rather than blanking the pane.
    const snap = getAgentSnapshot(id, 'ship')
    if (snap) return c.json({ ...(snap.payload as object), stale: true, fetched_at: snap.fetched_at })
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/**
 * GET /api/profiles/:id/prompt — render this agent's prompt without running a turn.
 *
 * Read-only. Lets you verify prompt assembly (and the volatile/stable split) without
 * spending an LLM call or a game tick. `?phase=planning|executing` to see a phase block.
 */
profiles.get('/:id/prompt', async (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const phaseParam = c.req.query('phase')
  const phase = phaseParam === 'planning' || phaseParam === 'executing' ? phaseParam : undefined
  let commandList = '(not fetched — agent not connected)'
  try {
    const agent = agentManager.getAgent(id)
    if (agent?.isConnected) {
      const cmds = await fetchGameCommands(profile.server_url, profile.connection_mode)
      commandList = formatCommandList(cmds)
    }
  } catch { /* prompt preview must never fail on a schema fetch */ }
  const system = buildSystemPrompt(profile, commandList, phase, id)
  const volatile = buildVolatileState(profile, id)
  return c.json({
    profile: profile.name,
    volatile_split: !!profile.volatile_split,
    system_prompt_chars: system.length,
    volatile_chars: volatile.length,
    command_list_chars: commandList.length,
    system_prompt: system,
    volatile_state: volatile,
  })
})

// POST /api/profiles/batch — batch connect/disconnect multiple agents
profiles.post('/batch', async (c) => {
  const body = await c.req.json()
  const action = body.action as string // 'connect_llm' | 'disconnect'
  const profileIds = body.ids as string[] | undefined // if undefined, all profiles
  const group = body.group as string | undefined // filter by group_name

  if (!action || !['connect_llm', 'disconnect'].includes(action)) {
    return c.json({ error: 'action must be connect_llm or disconnect' }, 400)
  }

  let targets = listProfiles()
  if (profileIds && profileIds.length > 0) {
    const idSet = new Set(profileIds)
    targets = targets.filter(p => idSet.has(p.id))
  }
  if (group) {
    targets = targets.filter(p => p.group_name === group)
  }

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = []

  for (const profile of targets) {
    try {
      if (action === 'disconnect') {
        await agentManager.disconnect(profile.id)
        results.push({ id: profile.id, name: profile.name, ok: true })
      } else {
        await agentManager.connect(profile.id)
        if (profile.provider && profile.provider !== 'manual' && profile.model) {
          await agentManager.startLLM(profile.id)
        }
        results.push({ id: profile.id, name: profile.name, ok: true })
      }
    } catch (err) {
      results.push({ id: profile.id, name: profile.name, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return c.json({ action, count: results.length, results })
})

// POST /api/profiles/:id/wind-down — finish accepted missions, take nothing
// new, then hand off to safe-dock. The turn budget is a backstop, not a target.
profiles.post('/:id/wind-down', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const turns = Number((body as Record<string, unknown>).turns ?? 60)
  const ok = agentManager.windDown(id, Number.isFinite(turns) && turns > 0 ? turns : 60)
  if (!ok) return c.json({ ok: false, error: 'Agent is not running' }, 400)
  return c.json({ ok: true, status: 'winding_down', turns })
})

// POST /api/profiles/:id/safe-dock — nudge agent to dock then auto-disconnect
profiles.post('/:id/safe-dock', async (c) => {
  const id = c.req.param('id')
  const status = agentManager.getStatus(id)
  if (!status.running) return c.json({ error: 'Agent is not running' }, 400)
  const ok = agentManager.safeDock(id)
  return c.json({ ok, status: 'docking' })
})

// POST /api/profiles/:id/nudge
profiles.post('/:id/nudge', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const message = (body as Record<string, unknown>).message as string
  if (!message?.trim()) return c.json({ error: 'message is required' }, 400)
  const status = agentManager.getStatus(id)
  if (!status.running) return c.json({ error: 'Agent is not running' }, 400)
  agentManager.nudge(id, message.trim())
  return c.json({ ok: true })
})

/**
 * Sell quotas — the Admiral's per-agent, per-item release of BoM-locked material.
 *
 * `SELL_CARGO_ALWAYS_EXCLUDE` in tools.ts blocks locked items on every path; a row here with
 * `remaining > 0` is the only thing that lets a specific quantity through. Both an absent row
 * and a zero row block, so granting is always an explicit act.
 *
 * These existed only as a DB function before: the sole way to release a sale mid-session was to
 * open data/admiral.db with a second connection and UPSERT by hand while the server was running.
 *
 * NOTE: tools.ts lowercases the item id before looking the quota up, so ids are normalised to
 * lower case on write and on delete. A quota stored as "Shield_Emitter" would never be found.
 */

// GET /api/profiles/:id/sell-quotas — what has been released for this agent, and what is left.
profiles.get('/:id/sell-quotas', (c) => {
  const id = c.req.param('id')
  if (!getProfile(id)) return c.json({ error: 'Profile not found' }, 404)
  return c.json({ quotas: listSellQuotas(id) })
})

// POST /api/profiles/:id/sell-quotas  body: { item_id, remaining }
// Sets (or overwrites) one allowance. Overwrites rather than adds — the Admiral authorises an
// exact quantity against the live commission quote, so a stale row must never accumulate.
profiles.post('/:id/sell-quotas', async (c) => {
  const id = c.req.param('id')
  if (!getProfile(id)) return c.json({ error: 'Profile not found' }, 404)

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const itemId = typeof body?.item_id === 'string' ? body.item_id.trim().toLowerCase() : ''
  if (!itemId) return c.json({ error: 'item_id is required and must be a non-empty string' }, 400)

  const remaining = body?.remaining
  if (typeof remaining !== 'number' || !Number.isInteger(remaining) || remaining < 0) {
    return c.json({ error: 'remaining is required and must be a non-negative integer' }, 400)
  }

  setSellQuota(id, itemId, remaining)
  return c.json({ ok: true, item_id: itemId, remaining })
})

// DELETE /api/profiles/:id/sell-quotas/:item_id — drop the row. Absent blocks exactly like zero.
profiles.delete('/:id/sell-quotas/:item_id', (c) => {
  const id = c.req.param('id')
  if (!getProfile(id)) return c.json({ error: 'Profile not found' }, 404)
  const itemId = c.req.param('item_id').trim().toLowerCase()
  if (!itemId) return c.json({ error: 'item_id is required' }, 400)
  return c.json({ ok: true, cleared: clearSellQuota(id, itemId), item_id: itemId })
})

export default profiles
