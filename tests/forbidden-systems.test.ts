import { beforeEach, describe, expect, test } from 'bun:test'
import {
  FORBIDDEN_SYSTEMS, CAPITAL_TIER, assessSystemDanger, banSystem, syncCapitalLossBans,
  refreshBannedSystems, listBannedSystems, recordActionEvents, getDb,
} from '../src/server/lib/db'
import { KILLZONES } from '../src/server/lib/places'

/**
 * THE NO-GO LIST IS LEARNED FROM CAPITAL-SHIP LOSSES — Brian, 2026-09-18.
 *
 * It began as the fleet's own graveyard. On 2026-09-14 Morg'Thar was cleared to take
 * more risk, flew into Alhena and lost the Warmaul, then a Gauntlet at Glenhaven — and
 * Algol had already eaten the Crimson Devastator on 2026-09-03 for 2,640,487, our worst
 * single loss. Brian, the morning after: "You should have kept him out of Alhena and where
 * he lost the previous [capital ship]."
 *
 * It then decayed into two hardcoded lists — db.ts's nine and places.ts's five — that
 * disagreed on six systems, while directives quoted the wrong one. On 2026-09-18 Brian
 * ruled: "reset all and learn new", and a ban is earned by the "loss of capital ship
 * level 4 or 5". The old test here said dropping any of the nine should be "a deliberate
 * act" that someone says out loud. This is that act, said out loud.
 *
 * So: nothing is hardcoded. The FULL loss record counts (it holds the Devastator), every
 * new capital loss bans its system the moment the game reports it, and a ban carries its
 * evidence and outlives the pruned event log. Small-ship losses — ross_248's 124 — do not
 * ban anything, by design.
 */

const TIERS: Record<string, number> = {
  shard: 0, cobble: 0, maul: 1, gauntlet: 2, warmaul: 3, crimson_devastator: 4, juggernaut: 5,
}
const tierOf = (c: string) => (c in TIERS ? TIERS[c]! : null)

let pid = ''
let eventId = 900_000_000
function loss(system: string, shipClass: string, extra: Record<string, unknown> = {}) {
  getDb().query(`INSERT INTO action_events (profile_id, event_id, created_at, category, event_type, data)
    VALUES (?, ?, ?, 'combat', 'combat.ship_destroyed', ?)`)
    .run(pid, eventId++, '2026-09-03T13:45:00Z', JSON.stringify({ system_id: system, ship_class: shipClass, ...extra }))
}

beforeEach(() => {
  const d = getDb()
  d.query('DELETE FROM banned_systems').run()
  d.query("DELETE FROM action_events WHERE event_type = 'combat.ship_destroyed'").run()
  pid = `p-bans-${Math.random().toString(36).slice(2)}`
  d.query('INSERT INTO profiles (id, name) VALUES (?, ?)').run(pid, `Ban Test ${pid}`)
  refreshBannedSystems()
})

describe('the no-go list is learned from capital-ship losses', () => {
  test('capital means tier 4 or 5', () => {
    expect(CAPITAL_TIER).toBe(4)
  })

  test('nothing is banned until a capital ship is lost — no hardcoded list survives', () => {
    expect(FORBIDDEN_SYSTEMS.size).toBe(0)
    for (const old of ['ross_248', 'goldcrest', 'bluerift', 'alhena', 'nekkar', '70_ophiuchi', 'lacaille_8760']) {
      expect(FORBIDDEN_SYSTEMS.has(old)).toBe(false)
    }
  })

  test('ross_248: 124 small-ship losses ban nothing — the rule is capital hulls', () => {
    const small = ['shard', 'cobble', 'maul', 'gauntlet', 'warmaul']
    for (let i = 0; i < 124; i++) loss('ross_248', small[i % small.length]!)
    expect(syncCapitalLossBans(tierOf)).toEqual([])
    expect(FORBIDDEN_SYSTEMS.has('ross_248')).toBe(false)
  })

  test('alhena: the Warmaul (tier 3) is not capital, so alhena stays open', () => {
    loss('alhena', 'warmaul', { insurance_payout: 516_324 })
    syncCapitalLossBans(tierOf)
    expect(FORBIDDEN_SYSTEMS.has('alhena')).toBe(false)
  })

  test('algol: the Crimson Devastator (tier 4) bans it, and the ban keeps its evidence', () => {
    loss('algol', 'crimson_devastator', { insurance_payout: 2_640_487, wreck_id: 'w-algol' })
    expect(syncCapitalLossBans(tierOf)).toEqual(['algol'])
    expect(FORBIDDEN_SYSTEMS.has('algol')).toBe(true)
    const row = listBannedSystems().find((r) => r.system_id === 'algol')!
    expect(row.ship_class).toBe('crimson_devastator')
    expect(row.ship_tier).toBe(4)
    expect(row.insurance_payout).toBe(2_640_487)
    expect(row.source).toBe('action_event')
  })

  test('a tier-5 loss bans too', () => {
    loss('t_jug_graveyard', 'juggernaut')
    syncCapitalLossBans(tierOf)
    expect(FORBIDDEN_SYSTEMS.has('t_jug_graveyard')).toBe(true)
  })

  test('a class the catalog cannot grade is skipped, never guessed', () => {
    loss('t_mystery', 'some_unknown_hull')
    expect(syncCapitalLossBans(tierOf)).toEqual([])
    expect(FORBIDDEN_SYSTEMS.has('t_mystery')).toBe(false)
  })

  test('syncing is idempotent', () => {
    loss('algol', 'crimson_devastator')
    expect(syncCapitalLossBans(tierOf)).toEqual(['algol'])
    expect(syncCapitalLossBans(tierOf)).toEqual([])
    expect(listBannedSystems().filter((r) => r.system_id === 'algol')).toHaveLength(1)
  })

  test('a ban outlives the pruned event log — that is how the Juggernaut loss fell out of view', () => {
    loss('algol', 'crimson_devastator')
    syncCapitalLossBans(tierOf)
    getDb().query("DELETE FROM action_events WHERE event_type = 'combat.ship_destroyed'").run()
    refreshBannedSystems()
    expect(FORBIDDEN_SYSTEMS.has('algol')).toBe(true)
  })

  test('a new capital loss bans its system the moment the game reports it', async () => {
    const { startCatalogService, getShip } = await import('../src/server/lib/catalog')
    startCatalogService()
    if (!getShip('crimson_devastator')) return        // no catalog cache on this machine: graded on the next sync
    recordActionEvents(pid, 'combat', [{
      event_id: eventId++, created_at: '2026-09-18T23:59:00Z', event_type: 'combat.ship_destroyed',
      data: { system_id: 't_fresh_loss', ship_class: 'crimson_devastator', cause: 'pirate' },
    } as any])
    expect(FORBIDDEN_SYSTEMS.has('t_fresh_loss')).toBe(true)
  })

  test('a hand-entered ban works, for losses the event log never captured', () => {
    banSystem({ system_id: '  T_Seeded  ', source: 'seed:test', ship_class: 'juggernaut', note: 'reported by Brian' })
    expect(FORBIDDEN_SYSTEMS.has('t_seeded')).toBe(true)
  })

  test('a banned system grades FORBIDDEN regardless of police, case- and space-insensitively', () => {
    banSystem({ system_id: 't_banned_policed', source: 'seed:test' })
    expect(assessSystemDanger('t_banned_policed').grade).toBe('FORBIDDEN')
    expect(assessSystemDanger('  T_BANNED_POLICED ').grade).toBe('FORBIDDEN')
  })

  test('there is ONE list: places.ts KILLZONES is the same Set', () => {
    expect(KILLZONES).toBe(FORBIDDEN_SYSTEMS)
    banSystem({ system_id: 't_one_list', source: 'seed:test' })
    expect(KILLZONES.has('t_one_list')).toBe(true)
  })

  test('the working systems stay open', () => {
    loss('algol', 'crimson_devastator')
    syncCapitalLossBans(tierOf)
    for (const ok of ['krynn', 'the_anvil', 'the_crucible', 'the_rampart', 'iron_reach', 'blood_forge', 'haven']) {
      expect(FORBIDDEN_SYSTEMS.has(ok)).toBe(false)
    }
  })
})
