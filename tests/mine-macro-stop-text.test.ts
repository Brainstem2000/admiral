import { describe, expect, test } from 'bun:test'
import { mineStopMessage } from '../src/server/lib/tools'
/**
 * Ledger Voss, 2026-09-11 06:20: the macro said "DONE … cargo now 185/450. Stopped:
 * max_mines." and he sailed ten jumps to sell 41% of a hold, thinking it was full.
 * A capped call now says PAUSED and tells the agent to call again.
 */
describe('mine_until_full stop text', () => {
  test('a max_mines stop below the target is a PAUSE that names the next action', () => {
    const m = mineStopMessage(80, 60, 185, 450, 'max_mines')
    expect(m.startsWith('mine_until_full PAUSED (not done)')).toBe(true)
    expect(m).toContain('185/450 (41%)')
    expect(m).toContain('Call mine_until_full again now')
    expect(m).not.toContain('DONE')
  })
  test('the deadline stop is a pause too', () => {
    expect(mineStopMessage(40, 30, 200, 450, 'deadline (5min)')).toContain('PAUSED')
  })
  test('full, depleted and error stops are DONE', () => {
    expect(mineStopMessage(23, 19, 450, 450, 'full')).toContain('mine_until_full DONE')
    expect(mineStopMessage(3, 0, 185, 450, 'no yield 3x (depleted?)')).toContain('mine_until_full DONE')
    expect(mineStopMessage(1, 0, 92, 750, 'error [no_mining] No mining equipment installed.')).toContain('mine_until_full DONE')
  })
  test('a max_mines stop that reached the stop percentage is DONE', () => {
    expect(mineStopMessage(80, 60, 405, 450, 'max_mines', 90)).toContain('mine_until_full DONE')
  })
})
