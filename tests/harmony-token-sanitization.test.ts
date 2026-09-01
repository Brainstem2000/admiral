import { describe, expect, test } from 'bun:test'

/**
 * gpt-oss models speak the harmony format. Its channel markers
 * (`<|channel|>`, `<|message|>`, ...) are meant to be consumed by the serving
 * layer's parser, but a local OpenAI-compatible server can leak one into a
 * tool call instead — observed on custom/gpt-oss-120b-MXFP4-Q8, which emitted
 * `game(facility<|channel|>commentary, action=list)`. That name can only ever
 * return `unknown_command`, so the turn is spent on a guaranteed error.
 */

function stubConnection(seen: string[]) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    // Record every dispatch: an action command also triggers the background
    // briefing collector, which issues its own queries on this connection.
    // The command under test is the FIRST one through.
    execute: async (command: string) => {
      seen.push(command)
      return { result: `ok:${command}` }
    },
    onNotification: () => {},
    getLocalState: () => null,
  } as any
}

function ctxFor(connection: any, logs: string[] = []) {
  return {
    connection,
    profileId: 'p-harmony-test',
    profileName: 'Test Agent',
    log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) },
    todo: '',
    memory: '',
  } as any
}

describe('harmony control tokens in command names', () => {
  test('a leaked channel marker is stripped instead of dispatched verbatim', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    const logs: string[] = []

    await executeTool(
      'game',
      { command: 'get_ship<|channel|>commentary', args: {} },
      ctxFor(stubConnection(seen), logs),
    )

    // The recovered name is what reaches the game, not the corrupted one.
    expect(seen[0]).toBe('get_ship')
    // ...and the repair is visible rather than silent.
    expect(logs.some(l => l.startsWith('system:Stripped model control tokens'))).toBe(true)
  })

  test('an ordinary command name is left untouched', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    const logs: string[] = []

    await executeTool('game', { command: 'get_status' }, ctxFor(stubConnection(seen), logs))

    expect(seen[0]).toBe('get_status')
    expect(logs.some(l => l.startsWith('system:Stripped model control tokens'))).toBe(false)
  })

  test('stripping preserves the command arguments', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    let passedArgs: Record<string, unknown> | undefined

    const conn = stubConnection(seen)
    conn.execute = async (command: string, args?: Record<string, unknown>) => {
      seen.push(command)
      if (seen.length === 1) passedArgs = args
      return { result: 'ok' }
    }

    await executeTool(
      'game',
      { command: 'view_market<|message|>', args: { item_id: 'iron_ore' } },
      ctxFor(conn),
    )

    expect(seen[0]).toBe('view_market')
    expect(passedArgs).toMatchObject({ item_id: 'iron_ore' })
  })

  test('a game() call nested inside another game() is unwrapped', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    let passedArgs: Record<string, unknown> | undefined

    const conn = stubConnection(seen)
    conn.execute = async (command: string, args?: Record<string, unknown>) => {
      seen.push(command)
      if (seen.length === 1) passedArgs = args
      return { result: 'ok' }
    }

    // Verbatim shape observed from custom/gpt-oss-120b-MXFP4-Q8: the marker is
    // on the WRAPPER name and the real call sits one level down. Stripping
    // alone would dispatch the bare tool name `game`, which is not a command.
    await executeTool(
      'game',
      {
        command: 'game<|channel|>commentary',
        args: { command: 'spacemolt_market_view_market', args: { item_id: 'cargo_expander_i' } },
      },
      ctxFor(conn),
    )

    // The v2 `spacemolt_` prefix is normalised away downstream, as for any
    // other command — what matters is that the real call, not the wrapper,
    // is what gets dispatched.
    expect(seen[0]).toBe('market_view_market')
    expect(passedArgs).toMatchObject({ item_id: 'cargo_expander_i' })
  })

  test('a real command carrying a `command` argument is not unwrapped', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    let passedArgs: Record<string, unknown> | undefined

    const conn = stubConnection(seen)
    conn.execute = async (command: string, args?: Record<string, unknown>) => {
      seen.push(command)
      if (seen.length === 1) passedArgs = args
      return { result: 'ok' }
    }

    // `help` legitimately takes a topic that can be a command name. Unwrapping
    // anything that merely carries a `command` key would eat calls like this.
    await executeTool('game', { command: 'help', args: { command: 'dock' } }, ctxFor(conn))

    expect(seen[0]).toBe('help')
    expect(passedArgs).toMatchObject({ command: 'dock' })
  })
})
