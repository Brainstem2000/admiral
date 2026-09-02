import { describe, expect, test } from 'bun:test'
import { normalizeModelText, looksDegenerate } from '../src/server/lib/text-safe'
import { readableThought } from '../src/server/lib/loop'

/**
 * Local-model repetition collapse.
 *
 * CyberSpock emitted 1,662 characters on 2026-09-02 whose visible content was
 * "STATUSThe...WeWeWeWeThe...We...We..." — padded with 77 zero-width spaces,
 * 93 non-breaking spaces and 206 newlines. It filled the dashboard log lane and
 * went back into the conversation for the model to feed on. Seen 6 times on
 * Spock and 4 on Morg'Thar inside a day, so it is a mode, not a fluke.
 */

// Rebuilt to the same shape as the captured row.
const COLLAPSE = 'STATUS' + '​ '.repeat(40) + '\n\n\n' +
  ['The', '...', 'We', 'We', 'We', 'We', 'The', '...', '...', 'We', '...', 'We', 'We', '...', 'We', 'This', 'The', 'We']
    .map(w => `${w} ​`).join('\n\n\n')

describe('normalizeModelText', () => {
  test('strips the invisible padding a collapse is made of', () => {
    const out = normalizeModelText(COLLAPSE)
    expect(out).not.toContain('​')
    expect(out).not.toContain(' ')
    expect(out.length).toBeLessThan(COLLAPSE.length / 2)
  })

  test('leaves ordinary prose intact', () => {
    const prose = 'Docked at War Citadel.\n\nNext: sell the carbon ore into the bid.'
    expect(normalizeModelText(prose)).toBe(prose)
  })
})

describe('looksDegenerate', () => {
  test('catches the captured collapse', () => {
    expect(looksDegenerate(COLLAPSE)).toBe(true)
  })

  test('catches a bare repetition with no padding at all', () => {
    expect(looksDegenerate('We need to. '.repeat(30))).toBe(true)
  })

  test('does NOT flag real agent reasoning', () => {
    const real = 'We are docked at Crimson War Citadel with 37,563 credits. The iron ore sell ' +
      'order has not filled because the bid is only 88 deep. Next action is to withdraw the ' +
      'ferrous slug cases from storage so they can be listed on the market for Morg to buy.'
    expect(looksDegenerate(real)).toBe(false)
  })

  test('does NOT flag legitimately repetitive short status text', () => {
    expect(looksDegenerate('STATUS: monitoring sell orders; no action required. — CyberSpock')).toBe(false)
  })

  test('short text is never judged degenerate', () => {
    expect(looksDegenerate('We We We')).toBe(false)
  })
})

describe('readableThought normalises before display', () => {
  test('a collapse does not reach the log with its padding', () => {
    const out = readableThought(COLLAPSE)
    expect(out).not.toContain('​')
    expect(out).not.toContain(' ')
  })
})
