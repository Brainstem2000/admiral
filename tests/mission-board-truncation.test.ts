/**
 * A truncated mission board hid the ids, and a mission you cannot name is a
 * mission you cannot accept.
 *
 * get_missions renders at up to 12,000 characters; the Crimson War Citadel board
 * measured 14,037. Everything past the cut loses its detailed entry — including
 * its mission_id — while still appearing in the summary lines above.
 *
 * Morg'Thar hit this at The Crucible Garrison on 2026-09-05. He could see
 * "Shipyard Supply: railgun_ii [delivery] 26785cr" and tried four spellings of
 * its id — shipyard_supply_railgun_ii, the template name, the title, a numeric
 * index — each answered mission_not_found, because the entry carrying the real
 * id had been cut off. He wrote it up as a blocker and moved to another station,
 * which was the right call, but a 26,785cr crimson-to-crimson delivery was
 * sitting there unreachable while he was under orders to earn Crimson
 * reputation by completing exactly that kind of contract.
 *
 * structuredContent carries every mission with its id no matter how long the
 * text runs, so the index is built from that and appended when the text is cut.
 */
import { test, expect, describe } from 'bun:test'

const CAPS: Record<string, number> = { get_missions: 12_000, get_active_missions: 12_000 }
const DEFAULT_CAP = 4_000

/** Mirrors missionIndexFor in tools.ts. */
function missionIndexFor(text: string, resultData: any, deepCommand?: string): string {
  if (deepCommand !== 'get_missions' && deepCommand !== 'get_active_missions') return ''
  const cap = (deepCommand && CAPS[deepCommand]) || DEFAULT_CAP
  if (text.length <= cap) return ''
  const arr = resultData?.missions ?? resultData?.available ?? resultData?.active
  if (!Array.isArray(arr) || arr.length === 0) return ''
  const lines = arr.map((m: any) => {
    const id = String(m.mission_id ?? m.id ?? m.template_id ?? '').trim()
    const title = String(m.title ?? m.name ?? '').trim()
    return id ? `  ${id}  ${title}`.trimEnd() : ''
  }).filter(Boolean)
  if (!lines.length) return ''
  return `\n\nEVERY MISSION ID ON THIS BOARD (the listing above was cut at ${cap} characters,`
    + ` so some entries lost their detail — accept by the id below):\n${lines.join('\n')}`
}

const LONG = 'x'.repeat(14_037)          // the real War Citadel board length
const SHORT = 'x'.repeat(500)
const DATA = { missions: [
  { mission_id: 'shipyard_supply_railgun_ii', title: 'Shipyard Supply: railgun_ii' },
  { mission_id: 'faction_af3ff9bcad5ad1827845042e87361638', title: 'HEXC supply contract: Silica Lens' },
  { id: 'first_haul', name: 'First Haul' },
]}

describe('a cut board still names every mission', () => {
  test("the contract Morg could not accept is now listed by id", () => {
    const idx = missionIndexFor(LONG, DATA, 'get_missions')
    expect(idx).toContain('shipyard_supply_railgun_ii')
    expect(idx).toContain('Shipyard Supply: railgun_ii')
  })

  test('it says why the index is there, so the agent knows entries were lost', () => {
    expect(missionIndexFor(LONG, DATA, 'get_missions')).toContain('cut at 12000 characters')
  })

  test('it falls back through id and template_id, not just mission_id', () => {
    expect(missionIndexFor(LONG, DATA, 'get_missions')).toContain('first_haul')
    expect(missionIndexFor(LONG, { missions: [{ template_id: 't_1', title: 'T' }] }, 'get_missions')).toContain('t_1')
  })

  test('active missions are covered too', () => {
    expect(missionIndexFor(LONG, { active: [{ mission_id: 'm1', title: 'A' }] }, 'get_active_missions')).toContain('m1')
  })
})

describe('it stays quiet when nothing was lost', () => {
  test('a board under the cap gets no index', () => {
    expect(missionIndexFor(SHORT, DATA, 'get_missions')).toBe('')
  })

  test('other commands are untouched however long they run', () => {
    expect(missionIndexFor(LONG, DATA, 'get_status')).toBe('')
    expect(missionIndexFor(LONG, DATA, undefined)).toBe('')
  })

  test('no structured data means no invented index', () => {
    expect(missionIndexFor(LONG, undefined, 'get_missions')).toBe('')
    expect(missionIndexFor(LONG, { missions: [] }, 'get_missions')).toBe('')
  })

  test('entries with no id at all are skipped rather than listed blank', () => {
    expect(missionIndexFor(LONG, { missions: [{ title: 'nameless' }] }, 'get_missions')).toBe('')
  })
})
