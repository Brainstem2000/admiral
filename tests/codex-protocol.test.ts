import { describe, expect, test } from 'bun:test'
import {
  buildCodexDynamicTools,
  buildCodexThreadParams,
  MIN_CODEX_TURN_TIMEOUT_MS,
  resolveCodexTurnTimeoutMs,
  shouldEndCodexTurnAfterTool,
} from '../src/server/lib/codex-app-server'

describe('Codex app-server safety boundary', () => {
  test('starts a restricted Admiral-owned thread', () => {
    const tools = buildCodexDynamicTools()
    const params = buildCodexThreadParams(
      'gpt-5.6-sol',
      'AUTHORITATIVE ADMIRAL STATE',
      'C:\\admiral\\data\\codex-home',
      tools,
    )

    expect(params.model).toBe('gpt-5.6-sol')
    expect(params.approvalPolicy).toBe('never')
    expect(params.sandbox).toBe('read-only')
    expect(params.baseInstructions).toBe('AUTHORITATIVE ADMIRAL STATE')
    expect(params.cwd).toBe('C:\\admiral\\data\\codex-home')
    expect(String(params.developerInstructions)).toContain('Use only the dynamic tools supplied by Admiral')
    expect(params.dynamicTools).toBe(tools)
  })

  test('exposes existing Admiral tools through the dynamic-tool protocol', () => {
    const tools = buildCodexDynamicTools()

    expect(tools.length).toBeGreaterThan(5)
    expect(tools.find(tool => tool.name === 'game')).toBeDefined()
    expect(tools.find(tool => tool.name === 'update_todo')).toBeDefined()
    expect(tools.find(tool => tool.name === 'update_memory')).toBeDefined()
    for (const tool of tools) {
      expect(tool.type).toBe('function')
      expect(tool.inputSchema).toBeTypeOf('object')
    }
  })

  test('allows bounded Admiral macros to outlive the legacy 90-second timeout', () => {
    expect(resolveCodexTurnTimeoutMs(90_000)).toBe(MIN_CODEX_TURN_TIMEOUT_MS)
    expect(resolveCodexTurnTimeoutMs(undefined, '90')).toBe(MIN_CODEX_TURN_TIMEOUT_MS)
    expect(resolveCodexTurnTimeoutMs(20 * 60_000)).toBe(20 * 60_000)
  })

  test('ends a Codex turn after one bounded Admiral macro', () => {
    expect(shouldEndCodexTurnAfterTool('mine_until_full')).toBe(true)
    expect(shouldEndCodexTurnAfterTool('goto_system')).toBe(true)
    expect(shouldEndCodexTurnAfterTool('sell_cargo')).toBe(true)
    expect(shouldEndCodexTurnAfterTool('game')).toBe(false)
    expect(shouldEndCodexTurnAfterTool('update_memory')).toBe(false)
  })
})
