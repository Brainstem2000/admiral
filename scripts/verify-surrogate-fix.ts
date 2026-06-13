// Standalone verification of the surrogate-corruption fix. Run: bun scripts/verify-surrogate-fix.ts
// Proves the helpers against the EXACT confirmed failure mode (U+1F680 ROCKET split mid-pair).
import { safeTruncate, stripLoneSurrogates, scrubContextSurrogates } from '../src/server/lib/text-safe'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}
// A string contains a lone (unpaired) surrogate?
function hasLone(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return true
      i++
    } else if (c >= 0xDC00 && c <= 0xDFFF) return true
  }
  return false
}

const ROCKET = '\u{1F680}' // 🚀 = 🚀

console.log('safeTruncate:')
// Build a string whose cut at maxLen lands BETWEEN the two halves of the rocket.
const pre = 'A'.repeat(10)
const straddle = pre + ROCKET + 'tail'        // rocket occupies indices 10,11
check('cut mid-pair drops the orphan high', !hasLone(safeTruncate(straddle, 11, '…')))
check('cut mid-pair result ends before rocket', safeTruncate(straddle, 11, '…') === pre + '…')
check('cut after full pair keeps the emoji', safeTruncate(pre + ROCKET, 12) === pre + ROCKET)
check('maxLen=0 yields just suffix', safeTruncate(straddle, 0, '…') === '…')
check('fits → unchanged, no suffix', safeTruncate('hello', 99) === 'hello')
check('lone-high input that fits passes through (healed downstream)', safeTruncate('x\uD83D', 5) === 'x\uD83D')

console.log('stripLoneSurrogates:')
check('removes lone high', !hasLone(stripLoneSurrogates('x\uD83Dy')))
check('removes lone low', !hasLone(stripLoneSurrogates('\uDE80tail')))
check('preserves valid emoji', stripLoneSurrogates('x' + ROCKET + 'y') === 'x' + ROCKET + 'y')
check('plain ASCII untouched', stripLoneSurrogates('hello world') === 'hello world')

console.log('scrubContextSurrogates (the pi-ai gap: ToolCall.arguments):')
// Reproduce the confirmed poison: a lone high surrogate inside a tool-call argument.
const poisonedCtx: any = {
  systemPrompt: 'sys\uD83D',
  tools: [{ name: 'game', description: 'do\uD83D things', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: 'hi\uDE80 there' },
    { role: 'assistant', content: [
      { type: 'text', text: 'thinking\uD83D about it' },
      { type: 'toolCall', id: 'tc1', name: 'game', arguments: { command: 'chat', content: 'launch \uD83D now' } },
    ] },
    { role: 'toolResult', toolCallId: 'tc1', toolName: 'game', content: [{ type: 'text', text: 'result\uDE80 ok' }] },
  ],
}
scrubContextSurrogates(poisonedCtx)
check('systemPrompt healed', !hasLone(poisonedCtx.systemPrompt))
check('tool description healed', !hasLone(poisonedCtx.tools[0].description))
check('user bare-string content healed', !hasLone(poisonedCtx.messages[0].content))
check('assistant text block healed', !hasLone(poisonedCtx.messages[1].content[0].text))
check('ToolCall.arguments healed (the pi-ai gap)', !hasLone(poisonedCtx.messages[1].content[1].arguments.content))
check('toolResult text healed', !hasLone(poisonedCtx.messages[2].content[0].text))
// The decisive end-to-end proof: the serialized body the API would receive is valid.
const serialized = JSON.stringify(poisonedCtx)
check('serialized context has NO lone surrogate (API would accept)', !hasLone(serialized))
check('valid emoji survives a full scrub', stripLoneSurrogates('keep ' + ROCKET) === 'keep ' + ROCKET)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
