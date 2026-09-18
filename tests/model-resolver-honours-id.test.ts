import { describe, expect, test } from 'bun:test'
import { resolveModel } from '../src/server/lib/model'

/**
 * The resolver must send the model the profile ASKED for, or nothing.
 *
 * pi-ai's `getModel` does not reliably miss on an unknown id — it resolves fuzzily and
 * returns the nearest thing it knows. On 2026-09-17 that silently turned every
 * `claude-sonnet-5` planner request into `claude-sonnet-4-0`, an id the API has retired,
 * so all ten hosted agents 404'd on every planning call while their haiku executors kept
 * working. It looked exactly like a provider outage: three wrong diagnoses (corrupted
 * context, account throttle, a timeout) before the 404 body was surfaced in the log.
 *
 * The guard is that a returned model is accepted only when its id equals the requested
 * one; anything else falls through to a clone that preserves the id. These tests pin the
 * property that actually matters — never substitute a different model for the one
 * configured — rather than the registry's contents, which move.
 */
describe('claude-max model resolution', () => {
  test('a model id the registry does not know keeps ITS OWN id, never a substitute', async () => {
    const { model } = await resolveModel('claude-max/claude-sonnet-5')
    expect((model as { id: string }).id).toBe('claude-sonnet-5')
    expect((model as { id: string }).id).not.toBe('claude-sonnet-4-0')
  })

  test('a made-up id is passed through rather than silently mapped to something real', async () => {
    const { model } = await resolveModel('claude-max/claude-not-a-real-model-9')
    expect((model as { id: string }).id).toBe('claude-not-a-real-model-9')
  })

  test('an unknown id still inherits a usable output cap, not a token starved one', async () => {
    const { model } = await resolveModel('claude-max/claude-sonnet-5')
    expect((model as { maxTokens: number }).maxTokens).toBeGreaterThan(4096)
    expect((model as { contextWindow: number }).contextWindow).toBeGreaterThan(100_000)
  })

  test('a model the registry DOES know resolves to itself', async () => {
    const { model } = await resolveModel('claude-max/claude-haiku-4-5')
    expect((model as { id: string }).id).toBe('claude-haiku-4-5')
  })
})
