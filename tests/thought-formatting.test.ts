import { describe, expect, test } from 'bun:test'
import { readableThought, recoverToolCallFromText } from '../src/server/lib/loop'

/**
 * A local model that fumbles a tool call emits its ARGUMENTS as text. Morg'Thar
 * (gpt-oss-120b on oMLX, 2026-09-02) repeatedly produced
 * `{"content": "- Verified: … - Next action: …"}` — update_todo's payload with
 * the tool name missing. Each one cost a wasted retry call, lost the TODO
 * write, and put a raw JSON blob into the dashboard log where a human is trying
 * to read what the agent is thinking.
 *
 * Two guards: the bare-arguments shape is recovered into the call it meant, and
 * anything JSON-shaped that still reaches the log lane is unwrapped for display.
 */

function textReply(text: string): any {
  return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: {} }
}

describe('recovering a bare arguments object', () => {
  test('{"content": …} becomes the update_todo call it meant', () => {
    const r = textReply('{\n  "content": "- Verified: at Segin, fuel 209/350.\\n- Next action: jump to alrakis."\n}')
    expect(recoverToolCallFromText(r, () => {})).toBe(true)
    expect(r.content[0].type).toBe('toolCall')
    expect(r.content[0].name).toBe('update_todo')
    expect(r.content[0].arguments.content).toContain('Next action')
  })

  test('an object with other keys alongside content is NOT guessed at', () => {
    const r = textReply('{"content": "hi", "channel": "faction"}')
    expect(recoverToolCallFromText(r, () => {})).toBe(false)
    expect(r.content[0].type).toBe('text')
  })

  test('ordinary prose is never rewritten into a call', () => {
    const r = textReply('I should jump to alrakis next, then scan for pirates.')
    expect(recoverToolCallFromText(r, () => {})).toBe(false)
  })
})

describe('readableThought', () => {
  test('unwraps the payload of a fumbled state write to its prose', () => {
    const blob = '{\n  "content": "- Verified: scanned GSC-0051, no targets.\\n- Next action: jump to segin."\n}'
    expect(readableThought(blob)).toBe('- Verified: scanned GSC-0051, no targets.\n- Next action: jump to segin.')
  })

  test('describes a fumbled game call instead of printing the blob', () => {
    expect(readableThought('{"command":"jump","args":{"id":"alkaid"}}')).toBe('(intended tool call) jump(id=alkaid)')
  })

  test('a fenced JSON blob is unwrapped too', () => {
    expect(readableThought('```json\n{"content": "hello there"}\n```')).toBe('hello there')
  })

  test('an unrecognised JSON object is described by its keys, not dumped', () => {
    const out = readableThought('{"foo": 1, "bar": 2}')
    expect(out).toContain('keys: foo, bar')
    expect(out).not.toContain('"foo"')
  })

  test('real prose passes through untouched', () => {
    const prose = 'We need to reload, then jump to the next corridor system.'
    expect(readableThought(prose)).toBe(prose)
  })

  test('malformed JSON is left alone rather than mangled', () => {
    const broken = '{"content": "unterminated'
    expect(readableThought(broken)).toBe(broken)
  })
})
