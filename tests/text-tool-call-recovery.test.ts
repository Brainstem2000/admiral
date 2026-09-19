import { describe, expect, test } from 'bun:test'
import { recoverToolCallFromText, repairToolName, readableThought, toolParamShapes } from '../src/server/lib/loop'

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

/**
 * A bare ARGUMENTS object with no tool name. gpt-oss on Ledger Voss, 2026-09-19 01:47 and 01:50 CT,
 * at a tungsten belt: `{"keep":"tungsten_ore"}` twice, each scored idle, one short of the backoff
 * parking him. It is recovered only when the keys fit exactly one declared tool.
 */
describe('tool calls emitted as a bare arguments object', () => {
  const SHAPES = toolParamShapes([
    { name: 'mine_until_full', parameters: { type: 'object', properties: { max_mines: {}, stop_at_pct: {}, keep: {} } } },
    { name: 'goto_system', parameters: { type: 'object', properties: { target_system: {}, dock_at_poi: {} }, required: ['target_system'] } },
    { name: 'fleet_route', parameters: { type: 'object', properties: { from: {}, to: {} }, required: ['from', 'to'] } },
    { name: 'update_todo', parameters: { type: 'object', properties: { content: {} }, required: ['content'] } },
    { name: 'update_memory', parameters: { type: 'object', properties: { content: {} }, required: ['content'] } },
    { name: 'status_log', parameters: { type: 'object', properties: { note: {} }, required: ['note'] } },
    { name: 'fleet_order', parameters: { type: 'object', properties: { note: {}, to: {} }, required: ['note'] } },
    { name: 'game', parameters: { type: 'object', properties: { command: {}, args: {} }, required: ['command'] } },
  ])
  function bare(text: string) {
    const m = msg(text); const logs: string[] = []
    const ok = recoverToolCallFromText(m, (t: string, s: string) => { logs.push(`${t}:${s}`) }, KNOWN, SHAPES)
    return { ok, call: m.content.find((c: any) => c.type === 'toolCall'), logs }
  }

  test('Ledger 2026-09-19: {"keep":"tungsten_ore"} is mine_until_full', () => {
    const r = bare('{"keep":"tungsten_ore"}')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('mine_until_full')
    expect(r.call.arguments).toEqual({ keep: 'tungsten_ore' })
    expect(r.logs.some(l => l.includes('Recovered a tool call'))).toBe(true)
  })

  test('a destination alone is goto_system', () => {
    const r = bare('```json\n{"target_system":"krynn","dock_at_poi":"crimson_war_citadel"}\n```')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('goto_system')
  })

  test('keys two tools accept are NOT guessed', () => {
    // status_log and fleet_order both take a lone `note`.
    expect(bare('{"note":"standing by"}').ok).toBe(false)
  })

  test('a missing required parameter does not fit', () => {
    expect(bare('{"dock_at_poi":"crimson_war_citadel"}').ok).toBe(false)
  })

  test('an unknown key fits nothing', () => {
    expect(bare('{"keep":"tungsten_ore","hurry":true}').ok).toBe(false)
    expect(bare('{}').ok).toBe(false)
  })

  test('a lone content payload still goes to update_todo, as before', () => {
    const r = bare('{"content":"1. mine"}')
    expect(r.ok).toBe(true)
    expect(r.call.name).toBe('update_todo')
  })

  test('without shapes the old behaviour stands', () => {
    const m = msg('{"keep":"tungsten_ore"}')
    expect(recoverToolCallFromText(m, () => {}, KNOWN)).toBe(false)
  })

  test('toolParamShapes reads properties and required off a JSON schema', () => {
    const sh = toolParamShapes([{ name: 't', parameters: { properties: { a: {}, b: {} }, required: ['a'] } }, { name: 'u' }])
    expect(sh.get('t')).toEqual({ props: ['a', 'b'], required: ['a'] })
    expect(sh.get('u')).toEqual({ props: [], required: [] })
  })
})
