import { Database } from 'bun:sqlite'
import path from 'node:path'
import type { Profile } from '../../src/shared/types'

const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)

const {
  createProfile,
  getCodexSession,
  updateProfile,
  upsertCodexSession,
} = await import('../../src/server/lib/db')

const profile: Omit<Profile, 'created_at' | 'updated_at'> = {
  id: 'profile-1',
  name: 'Migration Test',
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
  directive: 'Original directive',
  todo: 'Original TODO',
  memory: 'Original memory',
  context_budget: null,
  connection_mode: 'mcp_v2',
  server_url: 'https://game.spacemolt.com',
  autoconnect: true,
  enabled: true,
  sort_order: 0,
  group_name: '',
}

createProfile(profile)
updateProfile(profile.id, {
  codex_executor_enabled: true,
  codex_executor_model: 'gpt-5.6-terra',
})
updateProfile(profile.id, { directive: 'New directive', todo: 'New TODO', memory: 'New memory' })
upsertCodexSession(profile.id, 'planner', 'thread-planner', 'gpt-5.6-sol', 'schema')
upsertCodexSession(profile.id, 'executor', 'thread-executor', 'gpt-5.6-terra', 'schema')

const sqlite = new Database(path.join(workspace, 'data', 'admiral.db'), { readonly: true })
const history = sqlite.query(
  'SELECT field, value FROM profile_state_history WHERE profile_id = ? ORDER BY id'
).all(profile.id)
const saved = sqlite.query(
  'SELECT provider, model, planner_provider, planner_model, codex_executor_enabled FROM profiles WHERE id = ?'
).get(profile.id)

console.log(JSON.stringify({
  history,
  saved,
  plannerThread: getCodexSession(profile.id, 'planner')?.thread_id,
  executorThread: getCodexSession(profile.id, 'executor')?.thread_id,
}))
