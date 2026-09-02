import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Ghost stations must be able to die.
 *
 * fleet_intel_systems.has_station was a MAX() latch: once set, nothing an agent
 * observed could clear it. On 2026-09-02 a bad ingest flagged four systems
 * (horizon, distant_light, the_telescope, fuyue) as having a station, with one
 * station's service list copied onto each, and the hunter looped between them
 * looking for somewhere to dock. They were cleared by hand.
 *
 * Three rules now hold, all exercised here through the subprocess helper:
 *   1. a live get_system whose POIs carry no base CLEARS the flag and services;
 *   2. the public stations feed (each entry names its system) refutes any claim
 *      for a system it does not list, on every path that sets the flag;
 *   3. get_base resolves its system from the BASE'S identity via the feed, never
 *      from a system_id riding on the payload — that copied id is how the
 *      phantoms were made.
 *
 * Runs in a subprocess because db.ts binds DB_PATH from cwd at module load
 * (see nav-intel-injection.test.ts for the incident that made this structural).
 */

const tempDirectories: string[] = []
afterEach(() => {
  for (const d of tempDirectories.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

let cached: Record<string, any> | null = null
async function runHelper(): Promise<Record<string, any>> {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-stations-'))
  tempDirectories.push(dir)
  const helper = path.join(import.meta.dir, 'helpers', 'station-intel-check.ts')
  const child = Bun.spawn([process.execPath, helper, dir], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'))
  expect(line, `no __RESULT__ in:\n${out}\n${err}`).toBeDefined()
  cached = JSON.parse(line!.slice('__RESULT__'.length))
  return cached!
}

describe('ghost stations: the latch', () => {
  test('a live get_system with no base POI clears has_station and the copied services', async () => {
    const r = await runHelper()
    expect(r.latchCleared).toEqual({ system_id: 'phantom', has_station: 0, station_services: null })
  })

  test('a get_system with no POI list is not evidence and leaves the row alone', async () => {
    const r = await runHelper()
    expect(r.noPoisKept).toEqual({ system_id: 'kept', has_station: 1, station_services: 'market' })
  })

  test('without the feed, observations still set the flag (get_base and get_system)', async () => {
    const r = await runHelper()
    expect(r.noFeedBaseSets).toEqual({ system_id: 'lonely', has_station: 1, station_services: 'refuel' })
    expect(r.noFeedSystemSets?.has_station).toBe(1)
  })
})

describe('ghost stations: the feed refutes', () => {
  test('a base POI in a system the feed does not list never sets the flag', async () => {
    const r = await runHelper()
    expect(r.ghostRefused?.has_station ?? 0).toBe(0)
    expect(r.ghostRefused?.station_services ?? null).toBeNull()
  })

  test('a listed system is flagged and inherits the feed service list', async () => {
    const r = await runHelper()
    expect(r.realFlagged).toEqual({ system_id: 'realsys', has_station: 1, station_services: 'market,missions' })
  })

  test('the feed refutes even a payload that claims a base, so a latched phantom clears', async () => {
    const r = await runHelper()
    expect(r.feedRefutesLatch).toEqual({ system_id: 'phantom2', has_station: 0, station_services: null })
  })

  test('a feed older than a day is history, not evidence — observations rule again', async () => {
    const r = await runHelper()
    expect(r.staleFeedIgnored?.has_station).toBe(1)
  })
})

describe('ghost stations: the copy-id bug', () => {
  test('get_base lands on the system the feed puts the BASE in, not the system_id on the payload', async () => {
    const r = await runHelper()
    // ghost2 was the copied id; it must stay unflagged...
    expect(r.copyIdGhost).toEqual({ system_id: 'ghost2', has_station: 0, station_services: null })
    // ...and the services go to the station's real home.
    expect(r.copyIdReal).toEqual({ system_id: 'realsys', has_station: 1, station_services: 'market,missions,refuel' })
  })

  test('an unknown base claiming a feed-refuted system is refused', async () => {
    const r = await runHelper()
    expect(r.unknownBaseRefused).toEqual({ system_id: 'ghost3', has_station: 0, station_services: null })
  })
})

describe('ghost stations: backfill reconcile', () => {
  test('a plausible feed clears every flagged row it does not list, and fills in the ones it does', async () => {
    const r = await runHelper()
    expect(r.backfill.cleared).toBeGreaterThanOrEqual(1)
    expect(r.backfill.phantom3).toEqual({ system_id: 'phantom3', has_station: 0, station_services: null })
    expect(r.backfill.pad0).toEqual({ system_id: 'padsys_0', has_station: 1, station_services: 'refuel' })
    expect(r.backfill.realsys?.has_station).toBe(1)
  })

  test('an implausibly short feed fills in but clears nothing', async () => {
    const r = await runHelper()
    expect(r.shortFeed.cleared).toBe(0)
    expect(r.shortFeed.phantom4?.has_station).toBe(1)
  })
})
