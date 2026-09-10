import { describe, expect, test } from 'bun:test'
import { recoverToolCallFromText, repairToolName, readableThought } from '../src/server/lib/loop'

/**
 * gpt-oss on oMLX sometimes prints its tool call as TEXT in an OpenAI-style
 * envelope instead of using the tool channel. Ledger Voss, 2026-09-10 11:00-
 * 11:16 (verbatim from the dashboard):
 *   { "role": "Assistant", "function_call": { "name": "update_todo", "arguments": { "content": "TODO:\n- …" } } }
 *   { "role": "assistant", "function_call:": "update_ttodo", "arguments": { "content": "TODO: " } }
 * Each was logged as "(model emitted a JSON object with keys: role, function_call)",
 * scored as a text-only round, and three of them parked him in idle backoff
 * mid-corridor. The recovery now reads these envelopes, and a tool name one
 * or two edits from a declared tool is repaired.
 */

const KNOWN = new Set(['game', 'goto_system', 'mine_until_full', 'sell_cargo', 'update_todo', 'update_memory', 'status_log', 'fleet_route', 'codex'])

function msg(text: string) {
  return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: {} } as any
}
function recovered(text: string, known = KNOWN) {
  const m = msg(text); const logs: string[] = []
  const ok = recoverToolCallFromText(m, (t: string, s: string) => { logs.push(`${t}:${s}`) }, known)
  const call = m.content.find((c: any) => c.type === 'toolCall')
  return { ok, call, logs }
}

describe('tool calls emitted as text — OpenAI envelopes', () => {
  test('legacy function_call with an object argument, capitalised role', () => {
    const r = recovered('{ "role": "Assistant", "function_call": { "name": "update_todo", "arguments": { "content": "TODO:\\n- Verified" } } }')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('update_todo')
    expect(r.call.arguments.content).toContain('Verified')
  })

  test('mangled key "function_call:" holding a string name, with a typo repaired', () => {
    const r = recovered('{ "role": "assistant", "function_call:": "update_ttodo", "arguments": { "content": "TODO: " } }')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('update_todo')
    expect(r.logs.some(l => l.includes('repaired "update_ttodo" -> "update_todo"'))).toBe(true)
  })

  test('arguments as a JSON string are parsed', () => {
    const r = recovered('{"role":"assistant","function_call":{"name":"goto_system","arguments":"{\\"target_system\\":\\"gudja\\"}"}}')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('goto_system')
    expect(r.call.arguments.target_system).toBe('gudja')
  })

  test('modern tool_calls[] envelope', () => {
    const r = recovered('{"role":"assistant","content":null,"tool_calls":[{"id":"x","type":"function","function":{"name":"game","arguments":{"command":"jump","args":{"id":"gudja"}}}}]}')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('game')
    expect(r.call.arguments.command).toBe('jump')
  })

  test('a game command named directly inside the envelope is routed through game', () => {
    const r = recovered('{"role":"assistant","function_call":{"name":"jump","arguments":{"command":"jump","args":{"id":"gudja"}}}}')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('game')
  })

  test('the original game({...}) and {name, arguments} shapes still work', () => {
    expect(recovered('{"command":"scan","args":{}}').call.name).toBe('game')
    expect(recovered('{"name":"status_log","arguments":{"message":"hi"}}').call.name).toBe('status_log')
  })

  test('prose, and JSON that is not a call, are left untouched', () => {
    expect(recovered('We need to jump to gudja. Let\'s do that').ok).toBe(false)
    expect(recovered('{"role":"assistant","content":"just a note","extra":1}').ok).toBe(false)
  })

  test('name repair is conservative: ambiguous or distant names are left alone', () => {
    expect(repairToolName('update_ttodo', KNOWN)).toBe('update_todo')
    expect(repairToolName('updte_memory', KNOWN)).toBe('update_memory')
    expect(repairToolName('sell_everything', KNOWN)).toBe('sell_everything')
    expect(repairToolName('gme', KNOWN)).toBe('gme')
    expect(repairToolName('update_todo', undefined)).toBe('update_todo')
  })

  test('the thought lane names the intended call instead of listing keys', () => {
    expect(readableThought('{ "role": "assistant", "function_call": { "name": "update_todo", "arguments": {} } }')).toContain('update_todo')
    expect(readableThought('{ "role": "assistant", "function_call:": "update_ttodo", "arguments": {} }')).toContain('update_ttodo')
  })
})
