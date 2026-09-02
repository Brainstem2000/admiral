import { describe, expect, test } from 'bun:test'
import { dropOldestUntilUnderBudget } from '../src/server/lib/loop'

/**
 * Compaction must always return a context that FITS.
 *
 * CyberSpock (2026-09-02, gpt-oss-120b on oMLX) reached a 180,121-token history
 * against a 131,072-token window. Every call 400'd, all five retries 400'd, and
 * the emergency path never engaged because oMLX's wording ("Prompt too long:
 * … exceeds max context window of …") matched none of the exact phrases the
 * overflow test looked for. He took no action for three minutes per turn and
 * spent the time begging parked agents for credits.
 *
 * Two guards now exist: the overflow test is a pattern, and compaction ends
 * with a hard floor that drops the oldest messages until the history fits.
 */

function msg(role: 'user' | 'assistant' | 'toolResult', chars: number, i: number): any {
  if (role === 'user') return { role, content: 'u'.repeat(chars), timestamp: i }
  if (role === 'assistant') return { role, content: [{ type: 'text', text: 'a'.repeat(chars) }], timestamp: i }
  return { role, toolCallId: `c${i}`, toolName: 'game', content: [{ type: 'text', text: 'r'.repeat(chars) }], isError: false, timestamp: i }
}

describe('dropOldestUntilUnderBudget', () => {
  test('drops from the front until the history fits, and keeps the mission seed', () => {
    // 40 messages of ~1,143 tokens each (~45,700 total) against a 20,000 budget:
    // roughly 23 must go, which is well clear of the recent-message floor.
    const messages = [msg('user', 400, 0), ...Array.from({ length: 40 }, (_, i) => msg('assistant', 4000, i + 1))]
    const first = messages[0]
    const dropped = dropOldestUntilUnderBudget(messages, 20_000, 3.5)
    expect(dropped).toBeGreaterThan(0)
    expect(messages[0]).toBe(first)
    expect(messages.length).toBeGreaterThan(11)  // did not hit the floor
    const total = messages.reduce((n, m) => n + Math.ceil((typeof m.content === 'string' ? m.content.length : m.content[0].text.length) / 3.5), 0)
    expect(total).toBeLessThanOrEqual(20_000)
  })

  test('never trims below the recent-message floor, even if that stays over budget', () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg('assistant', 40_000, i))
    dropOldestUntilUnderBudget(messages, 100, 3.5)
    expect(messages.length).toBeGreaterThanOrEqual(11)
  })

  test('a history already under budget is left completely alone', () => {
    const messages = [msg('user', 100, 0), msg('assistant', 100, 1), msg('toolResult', 100, 2)]
    expect(dropOldestUntilUnderBudget(messages, 10_000, 3.5)).toBe(0)
    expect(messages).toHaveLength(3)
  })
})

describe('overflow detection', () => {
  // The exact wording each provider uses when the request will not fit.
  const wordings = [
    'prompt is too long: 180000 tokens > 131072 maximum',                                   // Anthropic
    "This model's maximum context length is 128000 tokens, however you requested 190000",   // OpenAI
    '400 Prompt too long: 180121 tokens exceeds max context window of 131072 tokens',       // oMLX (the one that got through)
    'Request too large: too many tokens in the prompt',                                     // Groq-ish
  ]
  const isOverflow = (m: string) =>
    /prompt (is )?too long|too many tokens|maximum context length|exceeds (the )?max(imum)? context|context window/i.test(m)

  test('every observed provider wording is recognised', () => {
    for (const w of wordings) expect(isOverflow(w), w).toBe(true)
  })

  test('ordinary failures are not mistaken for overflow', () => {
    for (const w of ['authentication_error: invalid api key', 'LLM returned empty response', '500 internal error']) {
      expect(isOverflow(w), w).toBe(false)
    }
  })
})
