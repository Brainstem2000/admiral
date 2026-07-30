import { describe, expect, test } from 'bun:test'
import type { Profile } from '../src/shared/types'
import {
  DEFAULT_CODEX_EXECUTOR_MODEL,
  DEFAULT_CODEX_PLANNER_MODEL,
  resolveProfileModelRouting,
} from '../src/server/lib/model-routing'

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'agent-1',
    name: 'Admiral Agent',
    username: null,
    password: null,
    empire: '',
    player_id: null,
    provider: 'claude-max',
    model: 'claude-sonnet-4-5',
    planner_provider: 'claude-max',
    planner_model: 'claude-opus-4-8',
    planning_interval: 5,
    codex_executor_enabled: false,
    codex_executor_model: null,
    codex_planner_enabled: false,
    codex_planner_model: null,
    directive: 'Keep the current mission.',
    todo: 'Mine ore.',
    memory: 'Never sell protected materials.',
    context_budget: null,
    connection_mode: 'mcp_v2',
    server_url: 'https://game.spacemolt.com',
    autoconnect: true,
    enabled: true,
    sort_order: 0,
    group_name: '',
    created_at: '2026-07-30',
    updated_at: '2026-07-30',
    ...overrides,
  }
}

describe('profile model routing', () => {
  test('leaves the existing Claude MAX dual-model route unchanged by default', () => {
    const source = profile()
    const before = structuredClone(source)

    expect(resolveProfileModelRouting(source)).toEqual({
      executor: { provider: 'claude-max', model: 'claude-sonnet-4-5' },
      planner: { provider: 'claude-max', model: 'claude-opus-4-8' },
      planningInterval: 5,
    })
    expect(source).toEqual(before)
  })

  test('overlays only the executor and retains the Claude planner', () => {
    const source = profile({
      codex_executor_enabled: true,
      codex_executor_model: 'gpt-5.6-terra',
    })

    expect(resolveProfileModelRouting(source)).toEqual({
      executor: { provider: 'codex-business', model: 'gpt-5.6-terra' },
      planner: { provider: 'claude-max', model: 'claude-opus-4-8' },
      planningInterval: 5,
    })
  })

  test('overlays only the planner and retains the Claude executor', () => {
    const source = profile({
      codex_planner_enabled: true,
      codex_planner_model: 'gpt-5.6-sol',
    })

    expect(resolveProfileModelRouting(source)).toEqual({
      executor: { provider: 'claude-max', model: 'claude-sonnet-4-5' },
      planner: { provider: 'codex-business', model: 'gpt-5.6-sol' },
      planningInterval: 5,
    })
  })

  test('supports independent Codex models for both planner and executor', () => {
    const source = profile({
      codex_executor_enabled: true,
      codex_executor_model: null,
      codex_planner_enabled: true,
      codex_planner_model: null,
      planning_interval: 3,
    })

    expect(resolveProfileModelRouting(source)).toEqual({
      executor: { provider: 'codex-business', model: DEFAULT_CODEX_EXECUTOR_MODEL },
      planner: { provider: 'codex-business', model: DEFAULT_CODEX_PLANNER_MODEL },
      planningInterval: 3,
    })
  })

  test('turning overrides off restores the exact baseline without changing state', () => {
    const source = profile({
      codex_executor_enabled: false,
      codex_executor_model: 'gpt-5.6-terra',
      codex_planner_enabled: false,
      codex_planner_model: 'gpt-5.6-sol',
    })
    const { executor, planner } = resolveProfileModelRouting(source)

    expect(executor).toEqual({ provider: source.provider, model: source.model })
    expect(planner).toEqual({ provider: source.planner_provider, model: source.planner_model })
    expect(source.directive).toBe('Keep the current mission.')
    expect(source.todo).toBe('Mine ore.')
    expect(source.memory).toBe('Never sell protected materials.')
  })
})
