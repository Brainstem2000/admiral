import { Hono } from 'hono'
import { listProfiles, getProfile, createProfile, updateProfile, deleteProfile, reorderProfiles } from '../lib/db'
import { agentManager } from '../lib/agent-manager'

const profiles = new Hono()

// GET /api/profiles
profiles.get('/', (c) => {
  const all = listProfiles()
  return c.json(all.map(p => ({ ...p, ...agentManager.getStatus(p.id) })))
})

// POST /api/profiles
profiles.post('/', async (c) => {
  const body = await c.req.json()
  const { name, username, password, empire, provider, model, planner_provider, planner_model, planning_interval, directive, connection_mode, server_url, context_budget } = body
  if (!name) return c.json({ error: 'Name is required' }, 400)
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
    return c.json(profile, 201)
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
  return c.json({ ...profile, ...status })
})

// PUT /api/profiles/:id
profiles.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const profile = updateProfile(id, body)
  if (!profile) return c.json({ error: 'Not found' }, 404)
  if (body.directive !== undefined) agentManager.restartTurn(id)
  return c.json(profile)
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
  const { command, args } = await c.req.json()
  if (!command) return c.json({ error: 'Missing command' }, 400)
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  try {
    const result = await agent.executeCommand(command, args)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
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
