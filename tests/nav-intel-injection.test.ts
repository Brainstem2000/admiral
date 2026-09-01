import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Fleet intel must reach the agent.
 *
 * Admiral collected 506 systems, 1,065 system links, killzones, wrecks and
 * daily danger grades — and NONE of it was injected into any agent prompt, so
 * agents rediscovered the map by flying into it.
 *
 * Morg'Thar, 2026-09-01: 24 of 44 tool calls in half an hour were navigation,
 * bouncing horizon -> distant_light -> horizon -> first_step looking for
 * somewhere to dock. Both horizon and distant_light have stations with
 * missions, refuel and repair; he had been to both and left, because nothing
 * told him what was there. Fuel 296 -> 132 for no gain.
 *
 * The injection is scoped to the CURRENT system plus direct neighbours, and
 * every list is capped — this is local knowledge, never the whole map.
 *
 * Runs in a subprocess: db.ts binds DB_PATH from cwd at module load, so an
 * in-process chdir is not real isolation once anything else has imported it.
 * (An earlier in-process version of this test wrote 43 fake systems into the
 * live fleet database, which then surfaced in an agent's briefing.)
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function runHelper(): Promise<Record<string, any>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-navintel-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'nav-intel-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  return JSON.parse(line!.slice('__RESULT__'.length))
}

describe('fleet intel injection', () => {
  test('an agent sees its own system and its neighbours, links being undirected', async () => {
    const r = await runHelper()
    expect(r.hubCurrentId).toBe('hub')
    // 'den' is stored as (hub, den); 'dead_end' as (dead_end, hub).
    expect(r.hubNeighbourIds).toContain('den')
    expect(r.hubNeighbourIds).toContain('dead_end')
    // ...and the reverse direction resolves too.
    expect(r.hubFromDeadEnd?.has_station).toBe(1)
    expect(r.hubFromDeadEnd?.station_services).toContain('missions')
  })

  test('it carries the facts agents waste turns rediscovering', async () => {
    const r = await runHelper()
    expect(r.hubFromDeadEnd?.station_services).toContain('refuel')
    expect(r.den?.danger).toBe('DANGEROUS')
    expect(r.den?.pirate_pois).toContain('Den Gas Cloud')
  })

  test('the injection is bounded — local knowledge, not the whole map', async () => {
    const r = await runHelper()
    // 40 neighbours were wired onto the hub.
    expect(r.hubNeighbourCount).toBeLessThanOrEqual(8)
  })

  test('hunting intel answers the standing combat questions', async () => {
    const r = await runHelper()
    expect(r.hunt.missionStations.some((m: any) => m.system_id === 'hub' && m.hops === 0)).toBe(true)
    const den = r.hunt.killzones.find((k: any) => k.system_id === 'den')
    expect(den?.pirates).toBe(9)
    expect(den?.poi_name).toContain('Den Gas Cloud')
  })

  test('hunting intel is capped so it cannot grow into an atlas', async () => {
    const r = await runHelper()
    // 30 extra killzones were reported.
    expect(r.hunt.killzones.length).toBeLessThanOrEqual(5)
    expect(r.hunt.wrecks.length).toBeLessThanOrEqual(5)
    expect(r.hunt.missionStations.length).toBeLessThanOrEqual(5)
  })

  test('an unknown system degrades quietly instead of throwing', async () => {
    const r = await runHelper()
    expect(r.unknown.current).toBeNull()
    expect(r.unknown.neighbours).toEqual([])
  })
})
