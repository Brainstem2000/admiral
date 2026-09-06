import { test, expect, describe } from 'bun:test'
import { isDoctrineRefusal } from '../src/server/lib/tools'

/**
 * A refused macro is not an action, and was being treated as one.
 *
 * `executeTool`'s macro branch unconditionally armed the action cooldown,
 * invalidated the briefing cache and logged a `tool_result` — even when
 * `executeMacroTool` had returned a doctrine refusal without touching the game.
 * Two consequences, both observed on Rook Vance on 2026-09-06:
 *
 * 1. The agent was rate-limited for an action it never performed. Eight
 *    refusals in six minutes each cost him a cooldown window on top of the
 *    turn already lost.
 * 2. Every refusal was logged TWICE — the guard wrote the full 545-char text,
 *    then this branch wrote a 200-char truncated copy. That doubled the
 *    guard-block alarm's count, so a threshold of "4 in 6 minutes" fired at
 *    two real refusals. Verified against the live table: ids 5542090 (545
 *    chars) and 5542091 (200 chars) are the same single refusal.
 *
 * `isDoctrineRefusal` is exported so the tool layer, the macro layer and
 * scripts/fleet-health.ts cannot drift apart on what counts as a block.
 */

describe('what counts as a doctrine refusal', () => {
  test('the destination gate', () => {
    expect(isDoctrineRefusal(
      'BLOCKED by Admiral doctrine: you set course for "krynn" 179s ago and are already re-routing')).toBe(true)
  })
  test('the jettison gate', () => {
    expect(isDoctrineRefusal('BLOCKED by Admiral doctrine: jettison is disabled fleet-wide')).toBe(true)
  })
  test('the wind-down refusal', () => {
    expect(isDoctrineRefusal('REFUSED: you are winding down. This is not a bug.')).toBe(true)
  })
})

describe('what does not', () => {
  test('an ordinary macro summary', () => {
    expect(isDoctrineRefusal('mine_until_full: 26 mines, cargo 218/800')).toBe(false)
  })
  test('a game error is the game talking, not a guard', () => {
    expect(isDoctrineRefusal('error: insufficient fuel for jump')).toBe(false)
  })
  test('narration that merely mentions a block', () => {
    // The same trap the alarm fell into: the words appear mid-sentence.
    expect(isDoctrineRefusal(
      'I was BLOCKED by Admiral doctrine last turn, so I will mine here instead')).toBe(false)
  })
  test('a board listing containing the word', () => {
    expect(isDoctrineRefusal('KEY FIELDS: 12 mission(s) - Blockade Runner [delivery]')).toBe(false)
  })
  test('empty and whitespace are not refusals', () => {
    expect(isDoctrineRefusal('')).toBe(false)
    expect(isDoctrineRefusal('   BLOCKED by Admiral doctrine')).toBe(false)  // must START with it
  })
})
