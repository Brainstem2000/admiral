import { describe, expect, test } from 'bun:test'
import { directiveForbidsSystem } from '../src/server/lib/directive-rules'

/**
 * The hunting briefing must never recommend a system the agent's own directive
 * forbids. On 2026-09-01 the CONFIRMED KILL ZONES block led with "Voss Redoubt:
 * pirates seen (max 14)" — Alhena, where Morg'Thar's directive said "the station
 * shoots you. Never enter." and where he had been refused at -10 reputation.
 */
const MORG = `MORG'THAR — HUNTER'S ORDERS
3. PLACES
- Frontier Station = POI mobile_capital, outerrim capital.
- Alhena / Voss Redoubt: reputation -10, the station shoots you. Never enter.
- FUEL: never buy fuel cells above 60cr; Sirius charged 300% tax.
- Goldcrest and Bluerift are fleet NO-GO systems.`

describe('directiveForbidsSystem', () => {
  test('a forbid phrase on the line that names the system', () => {
    expect(directiveForbidsSystem(MORG, 'alhena', 'Alhena')).toBe(true)
    expect(directiveForbidsSystem(MORG, 'goldcrest', 'Goldcrest')).toBe(true)
    expect(directiveForbidsSystem(MORG, 'bluerift', null)).toBe(true)
  })

  test('a system mentioned without a prohibition is not forbidden', () => {
    expect(directiveForbidsSystem(MORG, 'frontier', 'Frontier')).toBe(false)
    // "300% tax" is a price warning, not a no-go.
    expect(directiveForbidsSystem(MORG, 'sirius', 'Sirius')).toBe(false)
  })

  test('the prohibition must sit on the same line as the name', () => {
    const d = 'Never enter a station that refused you.\nAlhena has a good belt.'
    expect(directiveForbidsSystem(d, 'alhena', 'Alhena')).toBe(false)
  })

  test('ids with underscores match display names with spaces', () => {
    const d = '- First Step: pirate station, do not enter.'
    expect(directiveForbidsSystem(d, 'first_step', null)).toBe(true)
  })

  test('empty or missing directive forbids nothing', () => {
    expect(directiveForbidsSystem('', 'alhena', 'Alhena')).toBe(false)
    expect(directiveForbidsSystem(null, 'alhena', 'Alhena')).toBe(false)
  })
})
