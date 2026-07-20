import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile, reorderProfiles } from '../lib/db'
import { agentManager } from '../lib/agent-manager'

const profiles = new Hono()

// Never send the stored SpaceMolt password to the client. Expose has_password so
// the UI can indicate a password is set without leaking it.
function sanitizeProfile<T extends { password?: string | null }>(p: T): Omit<T, 'password'> & { has_password: boolean } {
  const { password, ...rest } = p
  return { ...rest, has_password: !!password }
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
  return c.json(all.map(p => {
    const status = agentManager.getStatus(p.id)
    // Persist live faction name to group_name so it survives disconnects
    const liveFaction = (status.gameState as Record<string, unknown> | null)?.faction as string | undefined
    if (liveFaction && liveFaction !== p.group_name) {
      updateProfile(p.id, { group_name: liveFaction })
      p.group_name = liveFaction
    }
    return sanitizeProfile({ ...p, ...status })
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
  return c.json(sanitizeProfile({ ...profile, ...status }))
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
  const { command, args, silent } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    const result = await agent.executeCommand(command, args, { silent: !!silent })
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
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

export default profiles
