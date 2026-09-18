import { describe, expect, test } from 'bun:test'

/**
 * `facility action='list'` answers for the station the calling agent is DOCKED AT, and says
 * which one only in its `base_id`. The Build Here page's "Under construction" panel fed on
 * that answer via a picker that took the faction leader or simply the first connected agent,
 * with no check on where they were standing.
 *
 * On 2026-09-18 the leader (CyberSpock) was connected while docked at central_nexus, twenty
 * jumps away. The panel then rendered THAT station's 8,829,000cr Singularity Charge Foundry —
 * short 6,982 reinforced_frame — under the heading "live from the station", reading as though
 * the faction had an eight-million-credit build in progress at War Citadel. It did not: our
 * own queue held one Hydrogen Combustion Chamber.
 *
 * Two guards, because either alone still misleads:
 *   1. only ask an agent docked at the home station, and drop the answer if its base_id
 *      disagrees — no data beats another station's data;
 *   2. ship the station id to the UI and NAME it, so the label can never imply "ours" again.
 */
const SRC = await Bun.file('src/server/routes/faction.ts').text()
const UI = await Bun.file('src/frontend/src/components/FactionVaultPane.tsx').text()

describe('the construction panel is scoped to the home station', () => {
  test('a home station constant exists and the picker uses it', () => {
    expect(SRC).toContain("const HOME_STATION = 'crimson_war_citadel'")
    expect(SRC).toContain('function pickAgentDockedAt')
    expect(SRC).toContain('pickAgentDockedAt(HOME_STATION)')
  })

  test('the picker filters on where the agent is DOCKED, not on name or list order', () => {
    const fn = SRC.slice(SRC.indexOf('function pickAgentDockedAt'), SRC.indexOf('function pickAgent('))
    expect(fn).toContain('dockedAt(p.id) === stationId')
    // the regression: falling back to "any connected agent" for a per-station answer
    expect(fn).not.toContain('LEADER_NAME_HINT')
  })

  test('an answer for the wrong station is dropped, not cached', () => {
    const fn = SRC.slice(SRC.indexOf('async function refreshStation'), SRC.indexOf('stationCache = {'))
    expect(fn).toContain('res.base_id')
    expect(fn).toContain('!== HOME_STATION')
    expect(fn).toContain('return')
  })

  test('the cache and the payload carry which station the answer describes', () => {
    expect(SRC).toContain('station_id: string; pending: unknown[]')
    expect(SRC).toContain('under_construction_station')
  })

  test('the UI names the station instead of saying "the station"', () => {
    expect(UI).toContain('under_construction_station')
    expect(UI).toContain('Under construction — live at {label(')
    expect(UI).not.toContain('Under construction — live from the station')
  })

  test('a missing station id is NOT defaulted to the home station', () => {
    // The first attempt at this fix shipped `?? 'crimson_war_citadel'`, so against a backend
    // that predates the server change the panel ASSERTED War Citadel over central_nexus data —
    // worse than the vague heading it replaced. Absent id must read as unverified.
    expect(UI).not.toContain("under_construction_station ?? 'crimson_war_citadel'")
    expect(UI).toContain('STATION UNVERIFIED')
  })
})
