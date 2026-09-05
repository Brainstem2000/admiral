/**
 * The reconcile block keeps its RULE and loses its volume.
 *
 * Injected every turn, it used to open "⚠️ AUTHORITATIVE", shout that memory was
 * STALE, and close on "Never plan around...". Agents mirrored it straight back:
 * Grit Vane opened 97% of his thoughts with a banner header, Morg'Thar 70%, and
 * CyberSpock 33% while running the LOCAL gpt-oss-120b — that last one is what
 * ruled out a per-model quirk and pointed at the shared prompt. A ritual
 * restatement every turn costs output every turn and buries a genuine warning.
 *
 * The rule itself is load-bearing and must survive: the briefing outranks memory
 * and TODO, which is what stops an agent planning around a ship it no longer
 * flies (Morg'Thar swapped hulls and his memory described the old one for hours).
 */
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'

const src = readFileSync('src/server/lib/agent.ts', 'utf-8')
const block = src.slice(src.indexOf('## Current Situation'), src.indexOf('## Current Situation') + 700)

describe('the precedence rule survives', () => {
  test('it still says the briefing wins over memory and TODO', () => {
    expect(block).toMatch(/memory or TODO disagrees/i)
    expect(block).toMatch(/this is right and the note is out of date/i)
  })

  test('it still tells the agent to correct the stale note', () => {
    expect(block).toMatch(/correct the note/i)
  })

  test('it still confines planning to the live ship and location', () => {
    expect(block).toMatch(/plan only around the ship and location shown here/i)
  })

  test('it still says not to re-query the injected data', () => {
    expect(block).toMatch(/no need to re-query/i)
  })
})

describe('the alarm framing is gone', () => {
  test('no warning glyphs or shouted absolutes', () => {
    for (const shout of ['⚠️', '🚨', 'AUTHORITATIVE', 'GROUND TRUTH', 'Never plan']) {
      expect(block).not.toContain(shout)
    }
  })

  test('STALE is not shouted at the agent every turn', () => {
    expect(block).not.toContain('STALE')
  })

  test('no all-caps imperative shouting in the instruction', () => {
    // "DO NOT re-query this data" was the old form.
    expect(block).not.toMatch(/DO NOT/)
  })
})
