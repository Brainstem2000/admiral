import { describe, expect, test, beforeEach } from 'bun:test'
import { swallow, isCodeDefect, resetSwallowed } from '../src/server/lib/swallow'

/**
 * `catch { /* must never break game execution *\/ }` is right for data and
 * wrong for defects. The ledger's trade_accept branch referenced an
 * out-of-scope name; the ReferenceError was swallowed by that policy and every
 * ledger row for the command vanished, silently, for a day. Pin the split.
 */

beforeEach(() => resetSwallowed())

describe('what counts as our bug', () => {
  test('a ReferenceError is a defect', () => {
    expect(isCodeDefect(new ReferenceError('profileId is not defined'))).toBe(true)
  })
  test('a TypeError is a defect', () => {
    expect(isCodeDefect(new TypeError("undefined is not an object"))).toBe(true)
  })
  test('an ordinary Error is not — that is the game or the DB talking', () => {
    expect(isCodeDefect(new Error('database is locked'))).toBe(false)
  })
  test('a thrown non-Error is not a defect', () => {
    expect(isCodeDefect('nope')).toBe(false)
    expect(isCodeDefect(undefined)).toBe(false)
  })
})

describe('reporting', () => {
  test('a defect is reported with its site and message', () => {
    const out: string[] = []
    expect(swallow('ledger.mapResult', new ReferenceError('profileId is not defined'), m => out.push(m))).toBe(true)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('ledger.mapResult')
    expect(out[0]).toContain('profileId is not defined')
    expect(out[0]).toContain('dropped silently')
  })

  test('a data error stays silent — the whole point of the catch', () => {
    const out: string[] = []
    expect(swallow('ledger.mapResult', new Error('database is locked'), m => out.push(m))).toBe(false)
    expect(out).toHaveLength(0)
  })

  test('a hot path reports once, not once per command', () => {
    const out: string[] = []
    for (let i = 0; i < 500; i++) {
      swallow('ledger.mapResult', new ReferenceError('profileId is not defined'), m => out.push(m))
    }
    expect(out).toHaveLength(1)
  })

  test('a different site or a different message still gets through', () => {
    const out: string[] = []
    swallow('ledger.mapResult', new ReferenceError('profileId is not defined'), m => out.push(m))
    swallow('ledger.insert', new ReferenceError('profileId is not defined'), m => out.push(m))
    swallow('ledger.mapResult', new ReferenceError('ctx is not defined'), m => out.push(m))
    expect(out).toHaveLength(3)
  })

  test('swallow never throws, whatever it is handed', () => {
    expect(() => swallow('x', null)).not.toThrow()
    expect(() => swallow('x', { message: 'shaped like an error' })).not.toThrow()
  })
})
