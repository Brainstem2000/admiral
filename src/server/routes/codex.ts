import { Hono } from 'hono'
import { codexSummary, codexList, codexGet, codexChain } from '../lib/catalog'

const codex = new Hono()

// GET /api/codex — version + counts
codex.get('/', (c) => c.json(codexSummary()))

// GET /api/codex/chain/:itemId?qty=N — preformatted crafting-chain analysis
// (registered before /:kind so "chain" is never treated as a kind)
codex.get('/chain/:itemId', (c) => {
  const qty = Math.max(1, parseInt(c.req.query('qty') ?? '1', 10) || 1)
  return c.json({ text: codexChain(c.req.param('itemId'), qty) })
})

// GET /api/codex/:kind?q=&limit= — searchable compact list
codex.get('/:kind', (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50))
  const rows = codexList(c.req.param('kind'), c.req.query('q') ?? '', limit)
  if (rows === null) return c.json({ error: 'unknown kind' }, 400)
  return c.json(rows)
})

// GET /api/codex/:kind/:id — full record (+ produced_by/consumed_by for items)
codex.get('/:kind/:id', (c) => {
  const entry = codexGet(c.req.param('kind'), c.req.param('id'))
  if (entry === null) return c.json({ error: 'not found' }, 404)
  return c.json(entry)
})

export default codex
