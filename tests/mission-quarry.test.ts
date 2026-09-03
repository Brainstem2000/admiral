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
