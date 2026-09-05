/**
 * A correct error was followed by a hint that contradicted it.
 *
 * `target` means a spatial entity for scan and attack, and an enum for commands
 * like view. On 2026-09-05 Ledger Voss called view(target="storage") and the
 * game answered precisely:
 *
 *   [invalid_target] Cannot view another player's storage.
 *   Use target="self" or target="faction".
 *
 * The harness then appended:
 *
 *   💡 HINT: Target "storage" is not at your current location. Use get_nearby()
 *   to see who is here. The target may have left or you may have the wrong ID.
 *
 * So he looked for a player called "storage", failed to find one, concluded
 * Crimson War Citadel had no faction lockbox, wrote that into his TODO as a
 * verified fact, and planned to mine 200 steel_plate to build a lockbox that had
 * been there all along holding 65 item types. The station's vault was readable
 * by him the whole time.
 *
 * When the game names the accepted values it has said it better than any local
 * hint can. The rule: never explain a target the game just explained, and never
 * give the spatial hint for a command whose target is not spatial.
 */
import { test, expect, describe } from 'bun:test'

const ENTITY_TARGET = new Set(['scan', 'attack', 'hail', 'follow', 'board', 'tractor', 'inspect'])

/** Mirrors the invalid_target branch in tools.ts. */
function hintFor(command: string, target: string, errMsg: string): string {
  const gameNamedTheOptions = /use\s+target\s*=|valid\s+(targets?|values?)/i.test(errMsg)
  if (!target && ENTITY_TARGET.has(command)) return 'requires a target_id'
  if (!gameNamedTheOptions && ENTITY_TARGET.has(command)) return 'not at your current location'
  return ''
}

const VIEW_ERR = `Cannot view another player's storage. Use target="self" or target="faction".`

describe('the harness does not contradict an error the game already answered', () => {
  test("Ledger's view(target=storage) gets no hint at all", () => {
    expect(hintFor('view', 'storage', VIEW_ERR)).toBe('')
  })

  test('specifically, it is never told the target is not at its location', () => {
    expect(hintFor('view', 'storage', VIEW_ERR)).not.toContain('not at your current location')
  })

  test('a command whose target is an enum never gets the spatial hint', () => {
    // Even with no explanation from the game, "storage" is not a place to fly to.
    expect(hintFor('view', 'storage', 'invalid_target')).toBe('')
    expect(hintFor('view_faction_storage', 'bucket', 'invalid_target')).toBe('')
  })
})

describe('the spatial hint still works where a target really is an entity', () => {
  test('attack with no target is told how to find one', () => {
    expect(hintFor('attack', '', 'invalid_target')).toBe('requires a target_id')
  })

  test('scan at a stale target is told it may have left', () => {
    expect(hintFor('scan', 'crt_88', 'invalid_target: no such entity')).toBe('not at your current location')
  })

  test('but not when the game listed the valid targets itself', () => {
    expect(hintFor('scan', 'crt_88', 'invalid_target. Valid targets: crt_1, crt_2')).toBe('')
  })
})
