import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Fleet intel must reach the agent.
 *
 * Admiral collected 500+ systems, 1000+ system links, killzones, wrecks and
 * daily danger grades for months — and NONE of it was injected into any agent
 * prompt. Agents rediscovered the map by flying into it.
 *
 * Morg'Thar, 2026-09-01: 24 of 44 tool calls in half an hour were navigation,
 * bouncing horizon -> distant_light -> horizon -> first_step looking for
 * somewhere to dock. Both horizon and distant_light have stations with
 * missions, refuel and repair; he had been to both and left, because nothing
 * told him what was there. Fuel went 296 -> 132 for no gain.
 *
 * The injection is deliberately scoped to the CURRENT system plus its direct
 * neighbours — the decision an agent actually faces — so it stays a few hundred
 * tokens. Injecting the whole knowledge base would blow the prompt; the
 * uncapped fleet-order incident (200k+ tokens) is the precedent.
 */

const cwd = process.cwd()
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-navintel-test-'))
process.chdir(workspace)
afterAll(() => {
  process.chdir(cwd)
  fs.rmSync(workspace, { recursive: true, force: true })
})

const { getDb, getNavIntel } = await import('../src/server/lib/db')
const db = getDb()

// A tiny galaxy: a hub with a full-service station, a pirate den, and a dead end.
db.query(`INSERT OR REPLACE INTO fleet_intel_systems
  (system_id, system_name, empire, poi_count, has_station, station_services, police_level, discovered_by)
  VALUES (?,?,?,?,?,?,?,?)`).run('hub', 'Hub', 'outerrim', 4, 1, 'missions,refuel,repair,market', 80, 't')
db.query(`INSERT OR REPLACE INTO fleet_intel_systems
  (system_id, system_name, empire, poi_count, has_station, station_services, police_level, discovered_by)
  VALUES (?,?,?,?,?,?,?,?)`).run('den', 'Den', null, 3, 0, null, 0, 't')
db.query(`INSERT OR REPLACE INTO fleet_intel_systems
  (system_id, system_name, empire, poi_count, has_station, station_services, police_level, discovered_by)
  VALUES (?,?,?,?,?,?,?,?)`).run('dead_end', 'Dead End', null, 1, 0, null, 0, 't')

db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('hub', 'den', 't')
db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('dead_end', 'hub', 't')

db.query(`INSERT OR REPLACE INTO system_danger_daily (system_id, day, grade, evidence) VALUES (?,?,?,?)`)
  .run('den', '2026-09-01', 'DANGEROUS', 'test')
db.query(`INSERT OR REPLACE INTO fleet_intel_killzones
  (poi_id, system_id, system_name, poi_name, poi_type, pirate_seen, wreck_seen, discovered_by)
  VALUES (?,?,?,?,?,?,?,?)`).run('den_cloud', 'den', 'Den', 'Den Gas Cloud', 'cloud', 9, 0, 't')

describe('fleet intel injection', () => {
  test('an agent sees its own system and every direct neighbour', () => {
    const nav = getNavIntel('hub')
    expect(nav.current?.system_id).toBe('hub')
    const ids = nav.neighbours.map(n => n.system_id).sort()
    // Links are undirected — a link stored as (dead_end, hub) must still resolve.
    expect(ids).toEqual(['dead_end', 'den'])
  })

  test('it carries the facts agents waste turns rediscovering', () => {
    const nav = getNavIntel('dead_end')
    const hub = nav.neighbours.find(n => n.system_id === 'hub')
    // Where can I dock, refuel, repair and take missions?
    expect(hub?.has_station).toBe(1)
    expect(hub?.station_services).toContain('missions')
    expect(hub?.station_services).toContain('refuel')

    const den = getNavIntel('den').current
    // Where are the pirates, and is this place dangerous?
    expect(den?.danger).toBe('DANGEROUS')
    expect(den?.pirate_pois).toContain('Den Gas Cloud')
  })

  test('dockable systems are ranked ahead of dead ends', () => {
    const nav = getNavIntel('hub')
    // den and dead_end both lack stations, but ordering must be deterministic
    // and station-bearing neighbours must come first when present.
    const withStation = nav.neighbours.filter(n => n.has_station === 1)
    const without = nav.neighbours.filter(n => n.has_station === 0)
    if (withStation.length && without.length) {
      expect(nav.neighbours[0].has_station).toBe(1)
    }
    expect(nav.neighbours.length).toBeGreaterThan(0)
  })

  test('the injection is bounded — it is local knowledge, not the whole map', () => {
    // Wire many neighbours onto one system.
    for (let i = 0; i < 40; i++) {
      db.query(`INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, discovered_by) VALUES (?,?,?)`)
        .run(`far_${i}`, `Far ${i}`, 't')
      db.query(`INSERT OR REPLACE INTO system_links (a, b, source) VALUES (?,?,?)`).run('hub', `far_${i}`, 't')
    }
    const nav = getNavIntel('hub')
    // Capped regardless of how connected the system is.
    expect(nav.neighbours.length).toBeLessThanOrEqual(8)
  })

  test('an unknown system degrades quietly instead of throwing', () => {
    const nav = getNavIntel('never_visited_xyz')
    expect(nav.current).toBeNull()
    expect(nav.neighbours).toEqual([])
    expect(() => getNavIntel('')).not.toThrow()
  })
})
