import { describe, expect, test } from 'bun:test'
import { DEFAULT_LLM_TIMEOUT_MS, LOCAL_LLM_TIMEOUT_MS, PROVIDER_LLM_TIMEOUT_MS, LOCAL_PROVIDERS } from '../src/server/lib/loop'

/**
 * The hosted timeout must sit ABOVE the measured planner-call distribution, not inside it.
 *
 * At 90s it sat inside. Hosted claude-sonnet-5 planner calls on 2026-09-17 measured
 * 67.2 / 73.9 / 74.4 / 81.4 / 85.3 / 91.4 / 97.5 / 98.6s, so a planner that wrote a long
 * plan was killed and a short one survived — and the kill surfaces only as
 * "An unknown error occurred", retries five times on the identical request, and parks the
 * agent. Five agents hit it inside two minutes and it read like a provider outage.
 *
 * These are cheap constant assertions on purpose: the bug was a NUMBER, so the guard is a
 * number, and it fails the moment someone lowers it back under the observed ceiling.
 */
const OBSERVED_MAX_PLANNER_MS = 98_600   // longest call that actually completed
const OBSERVED_KILLED_MS = 157_300       // longest call we killed mid-flight (Juno Freight)

describe('hosted LLM timeout', () => {
  test('clears the longest planner call that has ever completed, with real headroom', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThan(OBSERVED_MAX_PLANNER_MS * 1.5)
  })

  test('also clears the longest call we are known to have truncated', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThan(OBSERVED_KILLED_MS)
  })

  test('fits the output budget at the measured throughput', () => {
    // 6,076 output tokens in 98.6s on the call that landed => ~62 tok/s.
    const TOK_PER_S = 6076 / 98.6
    expect((DEFAULT_LLM_TIMEOUT_MS / 1000) * TOK_PER_S).toBeGreaterThan(8_000)
  })

  test('stays a hosted figure — still well under the local-server leash', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeLessThan(LOCAL_LLM_TIMEOUT_MS)
  })

  test('local providers keep their own longer timeout, not the hosted one', () => {
    for (const p of LOCAL_PROVIDERS) expect(PROVIDER_LLM_TIMEOUT_MS[p]).toBe(LOCAL_LLM_TIMEOUT_MS)
  })

  test('hosted providers are NOT in the per-provider table, so they use the default', () => {
    expect(PROVIDER_LLM_TIMEOUT_MS['anthropic']).toBeUndefined()
    expect(PROVIDER_LLM_TIMEOUT_MS['claude-max']).toBeUndefined()
  })
})
