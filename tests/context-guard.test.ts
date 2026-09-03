import { describe, expect, test } from 'bun:test'
import { enforceHardCeiling } from '../src/server/lib/loop'

/**
 * Morg'Thar, 2026-09-02 22:19: hunt_here returned 3 confirmed kills and 6
 * looted wrecks. His next call was rejected — 169,483 tokens against a 131,072
 * window. emergencyCompact recovered it, but only after the provider said no,
 * so every mid-turn overflow costs one wasted call and one logged error.
 *
 * Summarizing compaction can't run mid-turn (its split point is a user-message
 * boundary, so it would eat the turn's own opening). Dropping the OLDEST
 * messages has no such problem: the turn's recent work is what survives.
 */

const model = (contextWindow: number) => ({ id: 'test-model', contextWindow }) as any
const msg = (role: string, chars: number) => ({ role, content: 'x'.repeat(chars), timestamp: 0 }) as any
const toolResult = (chars: number) => ({
  role: 'toolResult',
  content: [{ text: 'y'.repeat(chars) }],
  timestamp: 0,
}) as any

describe('enforceHardCeiling', () => {
  test('a context that already fits is left completely alone', () => {
    const ctx = { systemPrompt: 'sys', messages: [msg('user', 100), msg('assistant', 100)] } as any
    const before = JSON.stringify(ctx.messages)
    expect(enforceHardCeiling(ctx, model(131072))).toBe(0)
    expect(JSON.stringify(ctx.messages)).toBe(before)
  })

  test('trims an oversized tool result rather than dropping messages', () => {
    // One giant result, small window: truncation alone should get under the bar.
    const ctx = { systemPrompt: 'sys', messages: [msg('user', 200), toolResult(80_000)] } as any
    const dropped = enforceHardCeiling(ctx, model(20_000))
    expect(dropped).toBe(0)                       // nothing thrown away
    expect(ctx.messages.length).toBe(2)
    expect(ctx.messages[1].content[0].text.length).toBeLessThan(4000)
    expect(ctx.messages[1].content[0].text).toContain('truncated')
  })

  test('drops the OLDEST messages, keeping the turn\'s recent work', () => {
    // dropOldestUntilUnderBudget keeps MIN_RECENT_MESSAGES (10) plus the seed,
    // so the fixture needs to be longer than that floor for any drop to happen.
    const ctx = {
      systemPrompt: 'sys',
      messages: [
        ...Array.from({ length: 15 }, () => msg('assistant', 40_000)),
        msg('assistant', 4_000),    // the turn's recent work — must survive
      ],
    } as any
    const seed = ctx.messages[0]
    const newest = ctx.messages[ctx.messages.length - 1]
    const dropped = enforceHardCeiling(ctx, model(30_000))
    expect(dropped).toBeGreaterThan(0)
    expect(ctx.messages[ctx.messages.length - 1]).toBe(newest)   // newest kept
    expect(ctx.messages[0]).toBe(seed)                           // mission seed kept
    expect(ctx.messages.length).toBeLessThan(16)
  })

  test('respects the minimum-tail floor rather than gutting a short context', () => {
    // Five enormous messages that cannot fit: the floor wins, and the caller
    // falls through to the provider (which is what emergencyCompact is for).
    const ctx = { systemPrompt: 'sys', messages: Array.from({ length: 5 }, () => msg('assistant', 90_000)) } as any
    expect(enforceHardCeiling(ctx, model(20_000))).toBe(0)
    expect(ctx.messages.length).toBe(5)
  })

  test('the 169,483-vs-131,072 case comes back under the window', () => {
    // ~4 chars/token, so 170k tokens is roughly 680k chars spread over a turn.
    const messages = Array.from({ length: 20 }, () => msg('assistant', 34_000))
    const ctx = { systemPrompt: 'x'.repeat(40_000), messages } as any
    enforceHardCeiling(ctx, model(131_072))
    const chars = ctx.messages.reduce((n: number, m: any) =>
      n + (typeof m.content === 'string' ? m.content.length : 0), 0)
    expect(chars / 4).toBeLessThan(131_072)
  })

  test('never empties the context down to nothing', () => {
    const ctx = { systemPrompt: 'sys', messages: [msg('user', 500_000), msg('assistant', 500_000)] } as any
    enforceHardCeiling(ctx, model(8_000))
    expect(ctx.messages.length).toBeGreaterThan(0)
  })

  test('a system prompt larger than the window does not produce a negative ceiling', () => {
    const ctx = { systemPrompt: 'x'.repeat(200_000), messages: [msg('user', 1000)] } as any
    expect(() => enforceHardCeiling(ctx, model(1000))).not.toThrow()
    expect(ctx.messages.length).toBe(1)
  })
})
