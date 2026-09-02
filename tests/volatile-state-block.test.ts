import { describe, expect, test } from 'bun:test'
import { VOLATILE_STATE_HEADER, VOLATILE_STATE_END, stripVolatileState } from '../src/server/lib/loop'

/**
 * The per-turn CURRENT STATE block (volatile split) is bracketed by two
 * delimiters so that (a) agent.ts can retire the previous turn's copy in place
 * and (b) the compaction summarizer can drop it from its transcript. Appending
 * a fresh ~9k-token copy every turn and summarizing the stale ones was the
 * compaction thrash observed on Morg'Thar 2026-09-01 (79% of turns compacted).
 */
describe('volatile state block delimiters', () => {
  test('stripping removes exactly the bracketed block and keeps the remainder', () => {
    const msg = `${VOLATILE_STATE_HEADER}Wallet: 67,950cr\nHull: 1776\n${VOLATILE_STATE_END}\nContinue your mission.`
    expect(stripVolatileState(msg)).toBe('Continue your mission.')
  })

  test('a message without the block is returned untouched', () => {
    expect(stripVolatileState('## Human Nudge\nGo hunt.')).toBe('## Human Nudge\nGo hunt.')
  })

  test('an unterminated block is dropped to the end (never leaks state into a summary)', () => {
    const msg = `Events first\n${VOLATILE_STATE_HEADER}Wallet: 1cr`
    expect(stripVolatileState(msg)).toBe('Events first\n')
  })
})
