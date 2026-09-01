import { describe, expect, test } from 'bun:test'
import { HttpV2Connection } from '../src/server/lib/connections/http_v2'

/**
 * http_v2 keeps a passively-harvested local state cache: it only advances when
 * a command response happens to carry the field. Movement responses (travel,
 * jump, dock, ...) do NOT reliably include a `location` object, so the cached
 * location kept reporting the system the agent had LEFT.
 *
 * Observed 2026-09-01: Morg'Thar's injected prompt said
 * `iron_reach / the_motherlode` while get_status put him at Glenhaven. The
 * execution prompt explicitly tells the agent "do NOT call get_status /
 * get_location — already injected, refreshed every 60s", so he had no way to
 * notice he was being fed a stale system. This is the same stale-cache class
 * of error that produced a wrong hand-written TODO the same day.
 *
 * Dropping the location on movement makes the cache honest: the loop's
 * periodic get_status refills it, and until then the field is simply absent
 * rather than confidently wrong.
 */

function harvest(conn: HttpV2Connection, payload: unknown, command?: string) {
  // harvestLocalState is private by design — this reaches past that on purpose,
  // because the observable behaviour (what getLocalState reports after a move)
  // is exactly what regressed.
  ;(conn as unknown as {
    harvestLocalState: (r: unknown, c?: string) => void
  }).harvestLocalState({ result: payload }, command)
}

function connection() {
  return new HttpV2Connection('https://game.spacemolt.com')
}

const AT_IRON_REACH = {
  player: { credits: 80901 },
  ship: { cargo_used: 92 },
  location: { system: 'iron_reach', poi: 'the_motherlode' },
}

describe('http_v2 local state cache', () => {
  test('a stale location does not survive a jump', () => {
    const c = connection()
    harvest(c, AT_IRON_REACH, 'get_status')
    expect((c.getLocalState()?.location as any)?.system).toBe('iron_reach')

    // The jump response carries no location — the real shape that caused this.
    harvest(c, { player: { credits: 80901 } }, 'jump')

    const loc = c.getLocalState()?.location
    expect(loc).toBeUndefined()
    // ...while everything else the cache legitimately knows is preserved.
    expect((c.getLocalState()?.player as any)?.credits).toBe(80901)
  })

  test('each movement verb clears it', () => {
    for (const cmd of ['travel', 'jump', 'dock', 'undock', 'goto_system', 'spacemolt_ship_travel']) {
      const c = connection()
      harvest(c, AT_IRON_REACH, 'get_status')
      harvest(c, { player: { credits: 1 } }, cmd)
      expect(c.getLocalState()?.location, `${cmd} should clear location`).toBeUndefined()
    }
  })

  test('a movement response that DOES carry a location updates it', () => {
    const c = connection()
    harvest(c, AT_IRON_REACH, 'get_status')
    harvest(c, {
      player: { credits: 80901 },
      location: { system: 'glenhaven', poi: 'orbit' },
    }, 'jump')

    expect((c.getLocalState()?.location as any)?.system).toBe('glenhaven')
  })

  test('non-movement commands leave the location alone', () => {
    const c = connection()
    harvest(c, AT_IRON_REACH, 'get_status')
    // A market read must not blank the system the agent is standing in.
    harvest(c, { player: { credits: 80901 } }, 'view_market')

    expect((c.getLocalState()?.location as any)?.system).toBe('iron_reach')
  })
})
