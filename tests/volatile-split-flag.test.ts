/**
 * `volatile_split` moves memory, TODO, briefings and fleet orders OUT of the
 * cached system prefix and into a per-turn message.
 *
 * It shipped half-connected: the column existed, `buildVolatileState` was wired
 * into both call sites in agent.ts, and the API returned the flag — but it was
 * missing from `updateProfile`'s allow-list, so nothing could ever switch it on.
 * Two profiles carried it from a manual DB write and the other ten could not.
 *
 * That gap is worth a test because it is invisible: every layer looks correct in
 * isolation and the feature is simply unreachable. Measured 2026-09-16, the cost
 * of it being off was 159.6M cache-WRITE tokens a day at write/read ratios of
 * 50-266% (healthy is 5-10%).
 */
import { test, expect } from 'bun:test'
import { createProfile, updateProfile, getProfile } from '../src/server/lib/db'
import { buildSystemPrompt, buildVolatileState } from '../src/server/lib/agent'

function makeProfile(name: string) {
  // createProfile does NOT mint an id — it inserts the one you hand it.
  return createProfile({
    id: crypto.randomUUID(),
    name, username: name, password: 'x', empire: 'crimson', player_id: 'p-' + name,
    provider: 'claude-max', model: 'claude-haiku-4-5',
    directive: 'Test directive.', connection_mode: 'lib_v2',
    server_url: 'https://game.spacemolt.com', autoconnect: 0, enabled: 1,
    todo: '', memory: '',
  } as never)
}

test('updateProfile can turn volatile_split on and off', () => {
  const p = makeProfile('vs-toggle-' + Date.now())
  expect(getProfile(p.id)?.volatile_split).toBeFalsy()

  updateProfile(p.id, { volatile_split: true } as never)
  expect(getProfile(p.id)?.volatile_split).toBe(1)

  updateProfile(p.id, { volatile_split: false } as never)
  expect(getProfile(p.id)?.volatile_split).toBe(0)
})

test('volatile_split is coerced to an integer, not stored as a raw boolean', () => {
  const p = makeProfile('vs-coerce-' + Date.now())
  updateProfile(p.id, { volatile_split: true } as never)
  const v = getProfile(p.id)?.volatile_split
  // SQLite will happily store a JS boolean; the prompt builder tests truthiness,
  // but the API and UI compare against 1/0. Keep it numeric like the other flags.
  expect(typeof v).toBe('number')
})

test('the volatile block leaves the cached system prompt when the flag is on', () => {
  const p = makeProfile('vs-prompt-' + Date.now())
  updateProfile(p.id, { memory: 'REMEMBER-THIS-TOKEN', todo: 'TODO-TOKEN' } as never)

  const off = getProfile(p.id)!
  const promptOff = buildSystemPrompt(off, 'cmds', undefined, p.id)

  updateProfile(p.id, { volatile_split: true } as never)
  const on = getProfile(p.id)!
  const promptOn = buildSystemPrompt(on, 'cmds', undefined, p.id)

  // With the split OFF the volatile content is interpolated into the cached
  // prefix — which is the whole cache-invalidation problem.
  expect(promptOff).toContain('REMEMBER-THIS-TOKEN')
  // With it ON the same content must NOT be in the system prompt...
  expect(promptOn).not.toContain('REMEMBER-THIS-TOKEN')
  // ...and must still be produced for delivery as a per-turn message, or the
  // agent silently loses its memory instead of merely re-reading it.
  expect(buildVolatileState(on, p.id)).toContain('REMEMBER-THIS-TOKEN')
})

test('the prompt tells the agent where its state actually is under each layout', () => {
  const p = makeProfile('vs-crossref-' + Date.now())
  const off = buildSystemPrompt(getProfile(p.id)!, 'cmds', undefined, p.id)
  updateProfile(p.id, { volatile_split: true } as never)
  const on = buildSystemPrompt(getProfile(p.id)!, 'cmds', undefined, p.id)

  // A wrong cross-reference sends the agent hunting for a block that is not
  // where it was told to look — which reads as the agent being confused.
  expect(on).toContain('CURRENT STATE message at the end of this conversation')
  expect(off).not.toContain('CURRENT STATE message at the end of this conversation')
})
