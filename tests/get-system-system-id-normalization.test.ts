import { describe, expect, test } from 'bun:test'

function ctxFor(connection: any) {
  return {
    connection,
    profileId: 'p-get-system-normalize',
    profileName: 'Test Agent',
    log: () => {},
    todo: '',
    memory: '',
  } as any
}

describe('get_system(system_id=...) normalization', () => {
  test('rewrites get_system(system_id=foo) to search_systems(query=foo)', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: Array<{ command: string; args?: Record<string, unknown> }> = []
    const conn = {
      mode: 'http_v2',
      isConnected: () => true,
      supportsNotifications: () => false,
      onNotification: () => {},
      getLocalState: () => null,
      execute: async (command: string, args?: Record<string, unknown>) => {
        seen.push({ command, args })
        return { result: 'ok' }
      },
    } as any

    await executeTool('game', { command: 'get_system', args: { system_id: 'iron_reach' } }, ctxFor(conn))
    expect(seen[0]?.command).toBe('search_systems')
    expect(seen[0]?.args).toMatchObject({ query: 'iron_reach' })
  })
})

