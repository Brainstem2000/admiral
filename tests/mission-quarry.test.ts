import { describe, expect, test } from 'bun:test'
import { missionQuarry, isMissionQuarry } from '../src/server/lib/tools'

/**
 * Morg'Thar, 2026-09-02: 21 confirmed kills in one night produced **765
 * credits** of realisable loot, spread across four empires — creature_carapace
 * bids 11 at depth 16, raw_xeno_meat and nitrogen_bladder bid 2 each. Ammo and
 * fuel over the same period cost more than the loot was worth, so his wallet
 * went DOWN. Grinding whatever stands at the POI is net negative.
 *
 * His missions pay 150-1,000cr per kill. He spent that night killing
 * Belt-Grazers after Grazer Cull had already reached 8/8, so those kills earned
 * nothing at all. hunt_here has to know what the agent is actually paid for.
 */

// Shaped like the real get_active_missions payload.
const MISSIONS = [
  { title: 'Trade Convoy Protection', objectives: [
    { description: 'Kill 5 pirates to protect trade convoys', current: 0, required: 5 } ] },
  { title: 'Ice-Field Thinning', objectives: [
    { description: 'Hunt 6 Rime-Grazers', current: 3, required: 6 } ] },
  { title: 'Grazer Cull', objectives: [
    { description: 'Hunt 8 Belt-Grazers', current: 8, required: 8, completed: true } ] },
  { title: 'Ghosts in the Cloud', objectives: [
    { description: 'Hunt 4 Sift-Rays in a gas cloud', current: 0, required: 4 } ] },
]

const t = (name: string, kind = 'creature') => ({ name, species: name.toLowerCase(), kind })

describe('missionQuarry', () => {
  test('collects the species from incomplete objectives', () => {
    const q = missionQuarry(MISSIONS)
    expect(q.has('rimegrazer')).toBe(true)
    expect(q.has('siftray')).toBe(true)
    expect(q.has('pirate')).toBe(true)
  })

  test('a COMPLETED objective stops counting — this is the whole point', () => {
    // Grazer Cull is 8/8. Belt-Grazers no longer pay, and Morg kept killing them.
    expect(missionQuarry(MISSIONS).has('beltgrazer')).toBe(false)
  })

  test('an objective already at its required count is dropped even without the flag', () => {
    const q = missionQuarry([{ objectives: [{ description: 'Hunt 4 Sift-Rays', current: 4, required: 4 }] }])
    expect(q.has('siftray')).toBe(false)
  })

  test('handles the wrapper shapes and junk without throwing', () => {
    expect(missionQuarry({ missions: MISSIONS }).has('siftray')).toBe(true)
    expect(missionQuarry({ active: MISSIONS }).has('siftray')).toBe(true)
    expect(missionQuarry(null).size).toBe(0)
    expect(missionQuarry([null, 'x', {}, { objectives: 'no' }]).size).toBe(0)
  })
})

describe('isMissionQuarry', () => {
  const q = missionQuarry(MISSIONS)

  test('matches quarry regardless of plural or hyphenation', () => {
    expect(isMissionQuarry(t('Rime-Grazer'), q)).toBe(true)
    expect(isMissionQuarry(t('Sift-Ray'), q)).toBe(true)
  })

  test('a pirate satisfies a "kill 5 pirates" objective by KIND', () => {
    expect(isMissionQuarry({ name: 'Scrapjaw Raider', species: 'raider', kind: 'pirate' }, q)).toBe(true)
  })

  test('the creatures Morg was actually grinding are correctly worthless', () => {
    expect(isMissionQuarry(t('Belt-Grazer'), q)).toBe(false)
    expect(isMissionQuarry(t('Patina-Grazer'), q)).toBe(false)
    expect(isMissionQuarry(t('Pressblister'), q)).toBe(false)
    expect(isMissionQuarry(t('Slag-Tortoise'), q)).toBe(false)
  })

  test('with no missions, nothing is quarry and ranking falls back to weakest-first', () => {
    expect(isMissionQuarry(t('Rime-Grazer'), new Set())).toBe(false)
  })
})

describe('target ranking', () => {
  // The sort hunt_here applies: mission quarry first, then weakest.
  const rank = (targets: Array<{ name: string; species: string; kind: string; hull: number }>, q: Set<string>) =>
    [...targets].sort((a, b) => {
      const am = isMissionQuarry(a, q) ? 0 : 1
      const bm = isMissionQuarry(b, q) ? 0 : 1
      return am !== bm ? am - bm : a.hull - b.hull
    })

  test('a paying target outranks a softer worthless one', () => {
    const q = missionQuarry(MISSIONS)
    const out = rank([
      { ...t('Belt-Grazer'), hull: 10 },     // softest, pays nothing
      { ...t('Rime-Grazer'), hull: 90 },     // tougher, pays 217cr
    ], q)
    expect(out[0].name).toBe('Rime-Grazer')
  })

  test('among equals, weakest still wins', () => {
    const q = missionQuarry(MISSIONS)
    const out = rank([
      { ...t('Sift-Ray'), hull: 80 },
      { ...t('Rime-Grazer'), hull: 30 },
    ], q)
    expect(out[0].name).toBe('Rime-Grazer')
  })

  test('with no quarry present it degrades to pure weakest-first', () => {
    const out = rank([
      { ...t('Pressblister'), hull: 50 },
      { ...t('Slag-Tortoise'), hull: 20 },
    ], missionQuarry(MISSIONS))
    expect(out[0].name).toBe('Slag-Tortoise')
  })
})

/**
 * get_active_missions answers as TEXT on Morg'Thar's connection. The first
 * version of missionQuarry handled only the structured form, so quarry came
 * back EMPTY, ranking silently fell through to weakest-first, and he carried on
 * killing Pressblisters twelve minutes after the fix deployed. Same dual-shape
 * trap that made get_system drop its jump-link table.
 */
const TEXT = `Active missions (5/5):
--- Trade Convoy Protection [05229a84] (combat, difficulty 4) ---
Thin out scout-class pirates threatening freight convoys.
Objectives:
  - Kill 5 pirates to protect trade convoys: 0/5
Rewards: 5,000cr
--- Ice-Field Thinning [b948e3aa] (combat, difficulty 2) ---
Progress: 50%
Objectives:
  - Hunt 6 Rime-Grazers: 3/6
Rewards: 1,300cr
--- Grazer Cull [b5f700df] (combat, difficulty 2) ---
Progress: 100%
Objectives:
  - Hunt 8 Belt-Grazers: 8/8 [DONE]
Rewards: 1,200cr
--- Ghosts in the Cloud [ae01b330] (combat, difficulty 2) ---
Objectives:
  - Hunt 4 Sift-Rays in a gas cloud: 0/4
Rewards: 2,000cr`

describe('missionQuarry — text payload', () => {
  test('extracts quarry from the text form', () => {
    const q = missionQuarry(TEXT)
    expect(q.has('rimegrazer')).toBe(true)
    expect(q.has('siftray')).toBe(true)
    expect(q.has('pirate')).toBe(true)
  })

  test('honours [DONE] — the exact bug that cost Morg his night', () => {
    expect(missionQuarry(TEXT).has('beltgrazer')).toBe(false)
  })

  test('honours a satisfied N/N count even without a DONE marker', () => {
    const q = missionQuarry('Objectives:\n  - Hunt 4 Sift-Rays: 4/4')
    expect(q.has('siftray')).toBe(false)
  })

  test('an unmet count is still quarry', () => {
    expect(missionQuarry('Objectives:\n  - Hunt 4 Sift-Rays: 1/4').has('siftray')).toBe(true)
  })

  test('text and structured payloads agree on the same missions', () => {
    const fromText = missionQuarry(TEXT)
    const fromObj = missionQuarry(MISSIONS)
    expect([...fromText].sort()).toEqual([...fromObj].sort())
  })

  test('prose that is not an objective line is ignored', () => {
    // The flavour line mentions pirates but is not an objective.
    const q = missionQuarry('Thin out scout-class pirates threatening convoys.')
    expect(q.size).toBe(0)
  })
})

/**
 * The WARNING version of the quarry check shipped at 00:22 and fired three
 * times on Morg'Thar between 01:27 and 01:30. He killed Patina-Grazers anyway
 * ("Use species. pirates not specific. Just hunt_here()") and his wallet fell
 * 1,092cr in fifty minutes WHILE HUNTING SUCCESSFULLY.
 *
 * This repo already learned the same lesson in the wrap-up reserve: "an earlier
 * version merely ASKED the model to persist and was measurably ignored. The
 * tool restriction is the load-bearing part." Advice is not a control.
 *
 * These assert the DECISION the macro makes, mirroring its guard condition.
 */
describe('refusing the unpaid kill', () => {
  // Mirrors the macro guard: refuse when the agent has contracts, nothing here
  // advances one, no explicit species was requested, and loot-only is not opted in.
  const refuses = (quarry: Set<string>, target: {name:string;species:string;kind:string},
                   opts: {species?: string; allowLootOnly?: boolean} = {}) =>
    quarry.size > 0 && !isMissionQuarry(target, quarry) && !opts.species && opts.allowLootOnly !== true

  const q = missionQuarry(MISSIONS)

  test('refuses the exact kill that lost Morg money', () => {
    expect(refuses(q, t('Patina-Grazer'))).toBe(true)
    expect(refuses(q, t('Belt-Grazer'))).toBe(true)
    expect(refuses(q, t('Pressblister'))).toBe(true)
  })

  test('allows the kill when it advances a contract', () => {
    expect(refuses(q, t('Rime-Grazer'))).toBe(false)
    expect(refuses(q, t('Sift-Ray'))).toBe(false)
    expect(refuses(q, {name:'Raider',species:'raider',kind:'pirate'})).toBe(false)
  })

  test('an explicit species request is an intentional hunt and is honoured', () => {
    expect(refuses(q, t('Patina-Grazer'), {species: 'patina'})).toBe(false)
  })

  test('allow_loot_only is the deliberate opt-out', () => {
    expect(refuses(q, t('Patina-Grazer'), {allowLootOnly: true})).toBe(false)
  })

  test('with NO contracts held, nothing is refused — loot hunting is legitimate', () => {
    expect(refuses(new Set(), t('Patina-Grazer'))).toBe(false)
  })
})

/**
 * A refusal the model can retry immediately is a loop, not a guard.
 *
 * Morg'Thar issued FOUR identical hunt_here() calls at Wazn Haze between 02:36
 * and 02:38 on 2026-09-03. Each was refused with NOTHING PAID HERE; each burned
 * a turn. The loop-breaker never fired because a macro refusal is a SUCCESSFUL
 * return, not an error, so nothing in the harness could see it.
 *
 * The macro already knew how to advance POIs — it did so when a POI was EMPTY.
 * The condition just did not cover "full of things that pay nothing".
 */
describe('POI advance condition', () => {
  // Mirrors the macro: advance when the POI is empty OR holds only unpaid species.
  const advance = (shootable: Array<{name:string;species:string;kind:string}>, q: Set<string>,
                   wantSpecies = '') =>
    shootable.length === 0 ||
    (q.size > 0 && !wantSpecies && shootable.length > 0 && !shootable.some(x => isMissionQuarry(x, q)))

  const q = missionQuarry(MISSIONS)

  test('advances off an empty POI (the original behaviour, unchanged)', () => {
    expect(advance([], q)).toBe(true)
  })

  test('advances off the POI that trapped Morg — creatures present, none paid', () => {
    expect(advance([t('Carrion-Moth'), t('Pall-Jelly')], q)).toBe(true)
    expect(advance([t('Cinder-Sylph'), t('Drift-Ray'), t('Pilot-Whale')], q)).toBe(true)
  })

  test('does NOT advance when paying quarry is present', () => {
    expect(advance([t('Carrion-Moth'), t('Sift-Ray')], q)).toBe(false)
    expect(advance([{name:'Raider',species:'raider',kind:'pirate'}], q)).toBe(false)
  })

  test('an explicit species hunt is never redirected', () => {
    expect(advance([t('Carrion-Moth')], q, 'moth')).toBe(false)
  })

  test('with no contracts held, a populated POI is left alone', () => {
    expect(advance([t('Carrion-Moth')], new Set())).toBe(false)
  })
})

/**
 * The first POI-advance fix ping-ponged: Morg'Thar bounced zosma_gas_pocket ->
 * zosma_belt repeatedly at 03:02 and 03:05. Two causes, both fixed here.
 *
 * 1. It recorded as "already checked" the POI reported by getLocalState, which
 *    does not reflect the macro's OWN travel — so it kept recording the POI it
 *    had left and re-selecting the same destination. The POI actually REFUSED
 *    at is what must be remembered.
 * 2. When every POI was already checked it fell back to "any POI except the
 *    current one", re-picking a rejected POI forever. An exhausted system must
 *    end the macro, because the remedy is a JUMP and the macro does not jump.
 */
describe('POI exhaustion', () => {
  const pickNext = (hunting: string[], cur: string, recent: string[]) =>
    hunting.find(p => p !== cur && !recent.includes(p)) ?? null

  test('picks an unchecked POI when one exists', () => {
    expect(pickNext(['gas', 'belt', 'ice'], 'gas', ['gas'])).toBe('belt')
  })

  test('does not re-pick a POI already found empty — the ping-pong', () => {
    expect(pickNext(['gas', 'belt'], 'belt', ['gas'])).toBeNull()
    expect(pickNext(['gas', 'belt'], 'gas', ['belt'])).toBeNull()
  })

  test('returns null when the whole system is checked, so the macro can abort', () => {
    expect(pickNext(['gas', 'belt', 'ice'], 'ice', ['gas', 'belt', 'ice'])).toBeNull()
  })

  test('remembering the REFUSED poi (not the departed one) breaks the cycle', () => {
    // Buggy: always records the stale departure POI, so 'belt' is never excluded.
    let buggy: string[] = []
    let choice = null
    for (let i = 0; i < 3; i++) {
      choice = pickNext(['gas', 'belt'], 'gas', buggy)
      if (!buggy.includes('gas')) buggy = ['gas', ...buggy]   // records departure
    }
    expect(choice).toBe('belt')            // picks belt forever

    // Fixed: records the POI actually refused at.
    let fixed: string[] = ['gas']
    const first = pickNext(['gas', 'belt'], 'gas', fixed)
    expect(first).toBe('belt')
    fixed = ['belt', ...fixed]             // refused at belt, record belt
    expect(pickNext(['gas', 'belt'], 'belt', fixed)).toBeNull()   // cycle broken
  })
})
