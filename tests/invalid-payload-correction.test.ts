/**
 * A refused call came back with the answer in it, and the agent retried the
 * same mistake anyway.
 *
 * On 2026-09-05 Morg'Thar called loot(id=...) and the game replied
 * "invalid_payload: Unknown parameter(s): id. Valid parameters: wreck_id,
 * item_id, module_id, quantity" — then he issued the identical call five more
 * times in six minutes. The sentence naming the right parameter was already in
 * front of him; prose was not enough.
 *
 * The harness already renames id -> target_id for scan and attack. Adding a
 * per-command rename for every such case does not scale, so this reads the
 * game's own error and hands back a corrected CALL, the same treatment the
 * actionless-call refusal gives. A rejected key is remapped only when exactly
 * one accepted parameter matches it; loot accepts three *_id parameters, so the
 * agent is shown the options rather than guessed at.
 */
import { test, expect, describe } from 'bun:test'

/** Mirrors the invalid_payload branch in tools.ts. */
function correct(command: string, sent: Record<string, unknown>, errMsg: string): string | null {
  const m = /Unknown parameter\(s\):\s*([^.]+)\.\s*Valid parameters:\s*([^.\n]+)/i.exec(errMsg)
  if (!m) return null
  const bad = m[1].split(',').map(x => x.trim()).filter(Boolean)
  const valid = m[2].split(',').map(x => x.trim()).filter(Boolean)
  const fixed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(sent)) if (valid.includes(k)) fixed[k] = v
  for (const b of bad) {
    const cands = valid.filter(v2 => v2 === b || v2.endsWith(`_${b}`))
    if (cands.length === 1) fixed[cands[0]] = sent[b]
  }
  const shown = Object.entries(fixed).map(([k, v]) =>
    `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`).join(', ')
  return shown ? `${command}(${shown})` : `${command}()`
}

const LOOT_ERR = 'invalid_payload: Unknown parameter(s): id. Valid parameters: wreck_id, item_id, module_id, quantity'

describe('the corrected call is built from the game\'s own error', () => {
  test('ambiguous keys are not guessed — loot accepts three *_id parameters', () => {
    // wreck_id, item_id and module_id all match "id", so none is chosen.
    const out = correct('loot', { id: 'wrk_88' }, LOOT_ERR)
    expect(out).toBe('loot()')
  })

  test('valid arguments the caller did send are carried through', () => {
    const out = correct('loot', { id: 'wrk_88', quantity: 5 }, LOOT_ERR)
    expect(out).toContain('quantity=5')
  })

  test('an unambiguous rename is applied', () => {
    const err = 'invalid_payload: Unknown parameter(s): id. Valid parameters: wreck_id, quantity'
    expect(correct('loot', { id: 'wrk_88' }, err)).toBe('loot(wreck_id="wrk_88")')
  })

  test('an exact-name match counts as unambiguous', () => {
    const err = 'invalid_payload: Unknown parameter(s): target. Valid parameters: target, quantity'
    expect(correct('attack', { target: 'npc_1' }, err)).toBe('attack(target="npc_1")')
  })

  test('several rejected keys are all reported', () => {
    const err = 'invalid_payload: Unknown parameter(s): id, scope. Valid parameters: wreck_id'
    expect(correct('loot', { id: 'w1', scope: 'all' }, err)).toBe('loot(wreck_id="w1")')
  })

  test('an unrelated error is left alone', () => {
    expect(correct('loot', { id: 'x' }, 'invalid_target: no such wreck')).toBeNull()
  })

  test('a rejected key with no counterpart is simply dropped, not invented', () => {
    const err = 'invalid_payload: Unknown parameter(s): colour. Valid parameters: wreck_id'
    expect(correct('loot', { colour: 'red', wreck_id: 'w9' }, err)).toBe('loot(wreck_id="w9")')
  })
})
