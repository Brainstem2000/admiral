import { describe, expect, test } from 'bun:test'
import { autoconnectCandidates, runAutoconnect, parseRunningRoster } from '../src/server/lib/autoconnect'
import type { Profile } from '../src/shared/types'

/**
 * A restart must bring the fleet back by itself.
 *
 * `autoconnect` was defined in the schema, read into the Profile, persisted
 * through create and update, defaulted to true for new profiles and surfaced in
 * the frontend type — and no server code ever read it. The flag was decorative.
 *
 * Observed live 2026-09-14: restarting `bun run dev` dropped all four working
 * agents (Ledger Voss, CyberSpock, Morg'Thar, Cass Margin) and minutes later
 * none had returned, every one of them with autoconnect true. Each had to be
 * revived by hand. The fleet runs unattended for hours, so a restart or a crash
 * parked the whole roster until somebody happened to look at the dashboard.
 *
 * These cover the selection rule and the pass's failure behaviour. No game
 * connection or LLM loop is opened — the connecting is injected.
 */

const p = (over: Partial<Profile>): Profile => ({
  id: 'p',
  name: 'Agent',
  enabled: true,
  autoconnect: true,
  provider: 'claude-max',
  model: 'claude-haiku-4-5',
  ...over,                      // overrides LAST, or every case is the default case
} as Profile)

/** "everyone was running" — isolates the flag rules from the roster rule. */
const ALL = ['live','disabled','opted-out','manual-provider','no-provider','no-model','local']

describe('autoconnectCandidates picks exactly the right profiles', () => {
  const roster = [
    p({ id: 'live', name: 'Ledger Voss' }),
    p({ id: 'disabled', name: 'Parked', enabled: false }),
    p({ id: 'opted-out', name: 'Manual starter', autoconnect: false }),
    p({ id: 'manual-provider', name: 'Hand-driven', provider: 'manual' }),
    p({ id: 'no-provider', name: 'No provider', provider: '' as unknown as string }),
    p({ id: 'no-model', name: 'No model', model: '' as unknown as string }),
    p({ id: 'local', name: 'CyberSpock', provider: 'custom', model: 'gpt-oss-120b' }),
  ]

  test('takes the enabled, opted-in, LLM-capable ones and nothing else', () => {
    expect(autoconnectCandidates(roster, ALL).map(x => x.id)).toEqual(['live', 'local'])
  })

  test('a disabled profile is never revived', () => {
    // enabled=false is how an agent is parked; the scheduler and the offline
    // wallet sweep already skip these and so must this.
    expect(autoconnectCandidates([p({ id: 'x', enabled: false })], ['x'])).toEqual([])
  })

  test('autoconnect false is honoured even when everything else is ready', () => {
    expect(autoconnectCandidates([p({ id: 'x', autoconnect: false })], ['x'])).toEqual([])
  })

  test('a manual or model-less profile is skipped, not connected loopless', () => {
    // Connecting these opens a game session with nothing driving it, which reads
    // as "connected" in the UI while doing no work.
    expect(autoconnectCandidates([
      p({ id: 'a', provider: 'manual' }),
      p({ id: 'b', model: undefined as unknown as string }),
      p({ id: 'c', provider: undefined as unknown as string }),
    ], ['a', 'b', 'c'])).toEqual([])
  })

  test('order follows the roster, so the fleet returns as the operator arranged it', () => {
    const ordered = [p({ id: 'first' }), p({ id: 'second' }), p({ id: 'third' })]
    expect(autoconnectCandidates(ordered, ['first','second','third']).map(x => x.id)).toEqual(['first', 'second', 'third'])
  })

  test('an empty roster is not an error', () => {
    expect(autoconnectCandidates([], [])).toEqual([])
  })
})

/** A pass harness that records calls and never sleeps for real. */
function harness(profiles: Profile[], opts: { fail?: Set<string>; stopped?: Set<string>; running?: string[] } = {}) {
  const calls = { connect: [] as string[], startLLM: [] as string[], sleeps: 0 }
  const deps = {
    listProfiles: () => profiles,
    runningBefore: () => opts.running ?? profiles.map(x => x.id),
    connect: async (id: string) => {
      calls.connect.push(id)
      if (opts.fail?.has(id)) throw new Error('game server refused the session')
    },
    startLLM: async (id: string) => { calls.startLLM.push(id) },
    isStopRequested: (id: string) => !!opts.stopped?.has(id),
    log: () => {},
    sleep: async () => { calls.sleeps++ },
    staggerMs: 1,
  }
  return { calls, deps }
}

describe('the boot pass', () => {
  test('connects and starts a loop for each candidate', async () => {
    const { calls, deps } = harness([p({ id: 'a' }), p({ id: 'b' })])
    const res = await runAutoconnect(deps)
    expect(calls.connect).toEqual(['a', 'b'])
    expect(calls.startLLM).toEqual(['a', 'b'])
    expect(res.connected).toEqual(['a', 'b'])
  })

  test('one failure does not park the rest — the whole point of the fix', async () => {
    const { calls, deps } = harness(
      [p({ id: 'a' }), p({ id: 'bad' }), p({ id: 'c' })],
      { fail: new Set(['bad']) },
    )
    const res = await runAutoconnect(deps)
    expect(res.failed).toEqual(['bad'])
    expect(res.connected).toEqual(['a', 'c'])
    // The failed one never gets a loop started on a connection it does not have.
    expect(calls.startLLM).toEqual(['a', 'c'])
  })

  test('it staggers rather than stampeding the model and the game API', async () => {
    const { calls, deps } = harness([p({ id: 'a' }), p({ id: 'b' }), p({ id: 'c' })])
    await runAutoconnect(deps)
    expect(calls.sleeps).toBe(2)          // between each pair, not before the first
  })

  test('an agent stopped mid-pass is left alone', async () => {
    // stopRequested is in-memory and empty at boot, but the pass spans minutes
    // and an operator can stop someone while it is still running.
    const { calls, deps } = harness(
      [p({ id: 'a' }), p({ id: 'stopped' }), p({ id: 'c' })],
      { stopped: new Set(['stopped']) },
    )
    const res = await runAutoconnect(deps)
    expect(res.skipped).toEqual(['stopped'])
    expect(calls.connect).toEqual(['a', 'c'])
  })

  test('nothing to do is quiet, not a crash', async () => {
    const { deps } = harness([p({ id: 'x', enabled: false })])
    const res = await runAutoconnect(deps)
    expect(res).toEqual({ connected: [], failed: [], skipped: [] })
  })

  test('an unreadable profile list does not take the boot down', async () => {
    const res = await runAutoconnect({
      listProfiles: () => { throw new Error('database locked') },
      runningBefore: () => [],
      connect: async () => {}, startLLM: async () => {},
      isStopRequested: () => false, log: () => {}, sleep: async () => {},
    })
    expect(res.connected).toEqual([])
  })
})

/**
 * The roster gate is the part that stops this feature doing harm.
 *
 * On 2026-09-14 ELEVEN of the fleet's profiles carried enabled+autoconnect while
 * only FOUR were meant to be running; the other seven had been parked by a
 * disconnect, which is in-memory state a restart forgets. Selecting on the flags
 * alone would have woken all eleven — token spend and live game actions on seven
 * agents nobody asked to run, and a breach of the two-agents-on-the-local-model
 * invariant on the way.
 */
describe('only what was actually running comes back', () => {
  const fleet = [
    p({ id: 'ledger' }), p({ id: 'spock' }), p({ id: 'morg' }), p({ id: 'cass' }),
    p({ id: 'bob' }), p({ id: 'vera' }), p({ id: 'grit' }),
  ]

  test('the four that were working return; the three parked ones do not', () => {
    const was = ['ledger', 'spock', 'morg', 'cass']
    expect(autoconnectCandidates(fleet, was).map(x => x.id)).toEqual(was)
  })

  test('an unknown roster connects NOBODY rather than guessing loudly', () => {
    // One hand-started restart is the status quo. Waking the whole roster is not.
    expect(autoconnectCandidates(fleet, [])).toEqual([])
  })

  test('a profile in the roster that has since been disabled stays down', () => {
    const later = [p({ id: 'ledger', enabled: false }), p({ id: 'spock' })]
    expect(autoconnectCandidates(later, ['ledger', 'spock']).map(x => x.id)).toEqual(['spock'])
  })

  test('a roster naming an id that no longer exists is harmless', () => {
    expect(autoconnectCandidates([p({ id: 'spock' })], ['deleted', 'spock']).map(x => x.id)).toEqual(['spock'])
  })

  test('the pass connects only the roster, even when more profiles qualify', async () => {
    const { calls, deps } = harness(fleet, { running: ['morg', 'cass'] })
    const res = await runAutoconnect(deps)
    expect(res.connected).toEqual(['morg', 'cass'])
    expect(calls.connect).toEqual(['morg', 'cass'])
  })
})

describe('parseRunningRoster survives a bad value', () => {
  test('reads a stored list', () => {
    expect(parseRunningRoster('["a","b"]')).toEqual(['a', 'b'])
  })

  test('missing, malformed or wrong-shaped values mean "we do not know"', () => {
    // Each must degrade to connecting nobody, never to connecting everybody.
    expect(parseRunningRoster(null)).toEqual([])
    expect(parseRunningRoster('')).toEqual([])
    expect(parseRunningRoster('not json')).toEqual([])
    expect(parseRunningRoster('{"a":1}')).toEqual([])
    expect(parseRunningRoster('[1,2,3]')).toEqual([])
  })
})
