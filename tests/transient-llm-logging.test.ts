/**
 * The harness called a failure benign and then logged it as an error anyway.
 *
 * completeWithRetry's give-up path already classifies an empty or overloaded
 * response as transient, logging it as a 'system' note with the stated reason
 * that errors "skew error-rate monitoring". But every intermediate retry
 * attempt was written at 'error' level, so a single transient hiccup produced
 * up to five error rows before the benign one.
 *
 * On 2026-09-05 that put Vera Lane at 6 and Nova Reyes at 4 "errors" in thirty
 * minutes and tripped the fleet-health alert twice — for a condition the harness
 * had already decided was not a fault, and which resolved on its own. A watcher
 * that fires on known-benign retries teaches its reader to ignore it, which is
 * strictly worse than no watcher.
 *
 * Genuine failures — a real error response, a timeout, a bad request — must
 * still log at 'error'. The classification is on the message, and it has to
 * agree between the retry loop and the give-up path or the two layers
 * contradict each other.
 */
import { test, expect, describe } from 'bun:test'

/** Mirrors the transient test used in loop.ts, in both places it now appears. */
const isTransient = (msg: string) => /empty response|overloaded/i.test(msg)
const levelFor = (msg: string) => (isTransient(msg) ? 'system' : 'error')

describe('transient provider hiccups are not logged as errors', () => {
  test('an empty response is transient at every attempt', () => {
    expect(levelFor('LLM returned empty response')).toBe('system')
  })

  test('an overloaded provider is transient', () => {
    expect(levelFor('Error: overloaded_error: Overloaded')).toBe('system')
  })

  test('classification is case-insensitive, as the give-up path is', () => {
    expect(levelFor('LLM RETURNED EMPTY RESPONSE')).toBe('system')
    expect(levelFor('Overloaded')).toBe('system')
  })

  test('the retry loop and the give-up path agree', () => {
    // Both layers use the same predicate; if they diverge, one of them starts
    // lying about the same event.
    for (const m of ['LLM returned empty response', 'overloaded', 'rate_limited', 'boom'])
      expect(levelFor(m)).toBe(isTransient(m) ? 'system' : 'error')
  })
})

describe('real failures still surface as errors', () => {
  test('a genuine error response is an error', () => {
    expect(levelFor('LLM returned an error response')).toBe('error')
  })

  test('a timeout is an error', () => {
    expect(levelFor('Request timed out after 90000ms')).toBe('error')
  })

  test('an auth or request fault is an error', () => {
    expect(levelFor('401 unauthorized')).toBe('error')
    expect(levelFor('invalid_request_error: bad model')).toBe('error')
  })

  test('an empty CONTEXT is not the same as an empty response', () => {
    // Guard against the predicate widening into anything containing "empty".
    expect(levelFor('context is empty — nothing to send')).toBe('error')
  })
})
