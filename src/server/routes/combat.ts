import { Hono } from 'hono'
import { seedBattlesFromEvents, listBattles, listUnenrichedBattles, enrichBattle, listDeathEvents } from '../lib/db'
import { agentManager } from '../lib/agent-manager'

/**
 * Kill ledger — every battle this agent fought, with what died and where.
 *
 * The Record card's aggregates come from server stats; this is the itemized
 * version. Base rows seed idempotently from combat.battle_ended action events
 * (the game's own log, already ingested each turn). The free `summary` battle
 * query fills in category (pirate/wildlife/pvp), the destroyed names, and the
 * opposing side — enrichment happens on ingest for new battles and via the
 * /enrich endpoint for the backlog. Server-side battle summaries can expire for
 * very old fights; those rows keep their base facts and stay marked unenriched.
 */
const combat = new Hono()

// GET /api/combat/:id — battles (newest first) + our own ship losses.
combat.get('/:id', (c) => {
  const id = c.req.param('id')
  seedBattlesFromEvents(id)
  const battles = listBattles(id).map(b => ({
    ...b,
    destroyed_names: JSON.parse(String(b.destroyed_names ?? '[]')),
    opponents: JSON.parse(String(b.opponents ?? '[]')),
  }))
  return c.json({
    profile_id: id,
    battles,
    deaths: listDeathEvents(id),
    unenriched: battles.filter(b => !b.enriched).length,
  })
})

// POST /api/combat/:id/enrich — run free `summary` queries through the agent's
// live connection for up to `limit` unenriched battles. Requires the agent
// connected (game-only is fine). Battles the server no longer remembers are
// marked enriched with what we have, so they stop being retried forever.
combat.post('/:id/enrich', async (c) => {
  const id = c.req.param('id')
  const agent = agentManager.getAgent(id)
  if (!agent || !agent.isConnected) return c.json({ error: 'Agent not connected' }, 400)
  seedBattlesFromEvents(id)
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 60)
  const pending = listUnenrichedBattles(id, limit)
  let ok = 0, gone = 0
  for (const { battle_id } of pending) {
    try {
      const r = await agent.executeCommand('summary', { id: battle_id }, { silent: true }) as Record<string, any>
      const sc = r?.structuredContent
      if (sc?.battle_id) {
        const sides = Array.isArray(sc.sides) ? sc.sides : []
        const players = new Set((Array.isArray(sc.player_names) ? sc.player_names : []).map((x: unknown) => String(x)))
        const opponents = sides.flatMap((s: any) => (Array.isArray(s.participants) ? s.participants : []))
          .filter((n: string) => !players.has(n))
        enrichBattle(battle_id, {
          category: sc.category, outcome: sc.outcome, system_name: sc.system_name,
          destroyed_names: sc.destroyed_names ?? [], opponents,
          ships_destroyed: sc.ships_destroyed,
        })
        ok++
      } else {
        // Server no longer has this battle — keep base facts, stop retrying.
        enrichBattle(battle_id, { destroyed_names: [], opponents: [] })
        gone++
      }
    } catch {
      enrichBattle(battle_id, { destroyed_names: [], opponents: [] })
      gone++
    }
    await new Promise(r => setTimeout(r, 150))
  }
  return c.json({ enriched: ok, expired: gone, remaining: listUnenrichedBattles(id, 1000).length })
})

export default combat
