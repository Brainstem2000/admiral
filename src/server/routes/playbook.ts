import { Hono } from 'hono'
import { listPlaybook, promotePlaybookEntry, verifyPlaybookEntry, failPlaybookEntry } from '../lib/db'

/**
 * The Playbook — the fleet's curated positive canon (see the table comment in
 * db.ts for the doctrine). The Admiral promotes/demotes; agents only ever READ
 * it, via their briefing. These routes exist for the Admiral and the UI.
 */
const playbook = new Hono()

// GET /api/playbook[?role=miner&all=1]
playbook.get('/', (c) => {
  const role = c.req.query('role') || undefined
  const includeInactive = c.req.query('all') === '1'
  return c.json({ entries: listPlaybook(role, includeInactive) })
})

// POST /api/playbook — promote (or re-verify by identical title)
playbook.post('/', async (c) => {
  const b = await c.req.json().catch(() => null) as Record<string, string> | null
  for (const k of ['class', 'title', 'body', 'evidence', 'kill_condition']) {
    if (!b?.[k] || typeof b[k] !== 'string') return c.json({ error: `${k} is required` }, 400)
  }
  if (!['LAW', 'TERRAIN', 'PATTERN'].includes(b!.class)) return c.json({ error: 'class must be LAW|TERRAIN|PATTERN — market snapshots never enter the playbook' }, 400)
  promotePlaybookEntry(b as never)
  return c.json({ ok: true })
})

// POST /api/playbook/:id/verify — a fresh confirmation in live play
playbook.post('/:id/verify', (c) => {
  verifyPlaybookEntry(Number(c.req.param('id')))
  return c.json({ ok: true })
})

// POST /api/playbook/:id/fail — a failed attempt or contradicting observation
playbook.post('/:id/fail', async (c) => {
  const b = await c.req.json().catch(() => ({})) as { reason?: string }
  failPlaybookEntry(Number(c.req.param('id')), b.reason ?? 'contradicted in live play')
  return c.json({ ok: true })
})

export default playbook
