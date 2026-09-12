import { describe, expect, test } from 'bun:test'
import { fuelFloorVerdict } from '../src/server/lib/tools'

/**
 * The fuel-floor checkpoint on `jump`. See fuelFloorVerdict for the stranding
 * that made it necessary to accept a bare fuel figure and to open the
 * repeat-to-proceed valve only toward a system with a station.
 */
const base = { floorPct: 20, cellRestore: 0, dest: 'hd_147513', destHasStation: false as boolean | null, repeat: false }

describe('fuel floor verdict', () => {
  test('a bare fuel figure (lib_v2 writes no max) is judged against the 10-unit floor, not ignored', () => {
    expect(fuelFloorVerdict({ ...base, fuelText: '1' }).block).toContain('tank 1 is under the 10-unit floor')
    expect(fuelFloorVerdict({ ...base, fuelText: '9' }).block).toContain('CHECKPOINT')
    expect(fuelFloorVerdict({ ...base, fuelText: '12' }).block).toBeNull()
  })
  test('n/max uses the percentage floor (20% of 180 = 36)', () => {
    expect(fuelFloorVerdict({ ...base, fuelText: '5/180' }).block).toContain('tank 5/180 is under the 36-unit floor')
    expect(fuelFloorVerdict({ ...base, fuelText: '40/180' }).block).toBeNull()
  })
  test('cargo cells that can bring the tank back above the floor clear the checkpoint', () => {
    expect(fuelFloorVerdict({ ...base, fuelText: '5/180', cellRestore: 40 }).block).toBeNull()
    expect(fuelFloorVerdict({ ...base, fuelText: '5/180', cellRestore: 20 }).block).toContain('can only restore 20')
  })
  test('repeating the jump proceeds only toward a system with a station', () => {
    const toStation = fuelFloorVerdict({ ...base, fuelText: '5/180', repeat: true, dest: 'lhs_1140', destHasStation: true })
    expect(toStation.block).toBeNull(); expect(toStation.proceedOnRepeat).toBe(true)
    const toBelt = fuelFloorVerdict({ ...base, fuelText: '5/180', repeat: true, destHasStation: false })
    expect(toBelt.block).toContain('no station the fleet knows of'); expect(toBelt.proceedOnRepeat).toBe(false)
    const toUnknown = fuelFloorVerdict({ ...base, fuelText: '5/180', repeat: true, dest: 'gsc_0099', destHasStation: null })
    expect(toUnknown.block).toContain('distress_signal'); expect(toUnknown.proceedOnRepeat).toBe(false)
  })
  test('no reading at all stands the gate down rather than guessing', () => {
    expect(fuelFloorVerdict({ ...base, fuelText: '' })).toEqual({ block: null, proceedOnRepeat: false })
    expect(fuelFloorVerdict({ ...base, fuelText: 'unknown' }).block).toBeNull()
  })
})
