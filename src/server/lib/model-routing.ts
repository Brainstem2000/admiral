import type { Profile } from '../../shared/types'

export const CODEX_BUSINESS_PROVIDER = 'codex-business'
export const DEFAULT_CODEX_EXECUTOR_MODEL = 'gpt-5.6-terra'
export const DEFAULT_CODEX_PLANNER_MODEL = 'gpt-5.6-sol'

export interface ModelRole {
  provider: string
  model: string
}

export interface ProfileModelRouting {
  executor: ModelRole
  planner: ModelRole | null
  planningInterval: number
}

/**
 * Resolve the effective models without mutating the profile.
 *
 * The normal provider/model values are deliberately retained as the rollback
 * baseline. Codex Business can independently overlay either role, preserving
 * Admiral's existing dual-model cadence and allowing mixed Claude/Codex pairs.
 */
export function resolveProfileModelRouting(profile: Profile): ProfileModelRouting {
  if (!profile.provider || !profile.model) {
    throw new Error('No baseline LLM provider/model configured')
  }

  const executor = profile.codex_executor_enabled
    ? {
        provider: CODEX_BUSINESS_PROVIDER,
        model: profile.codex_executor_model || DEFAULT_CODEX_EXECUTOR_MODEL,
      }
    : {
        provider: profile.provider,
        model: profile.model,
      }

  let planner: ModelRole | null = null
  if (profile.codex_planner_enabled) {
    planner = {
      provider: CODEX_BUSINESS_PROVIDER,
      model: profile.codex_planner_model || DEFAULT_CODEX_PLANNER_MODEL,
    }
  } else if (profile.planner_model) {
    planner = {
      provider: profile.planner_provider || profile.provider,
      model: profile.planner_model,
    }
  }

  return {
    executor,
    planner,
    planningInterval: profile.planning_interval ?? 5,
  }
}

export function isCodexBusinessRole(role: ModelRole): boolean {
  return role.provider === CODEX_BUSINESS_PROVIDER
}
