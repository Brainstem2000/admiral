import { describe, expect, test } from 'bun:test'

/**
 * PARK: stop the LLM loop, keep the game connection.
 *
 * The capability that makes this worth a button: `/api/profiles/:id/command` gates on
 * `agent.isConnected` and NEVER on `running`, and `Agent.executeCommand` only needs
 * `this.connection`. So an agent with its loop stopped still executes commands — not just
 * free reads, but ACTIONS, including `facility job_add`. Crafting chains can be fed by
 * agents that are not thinking, at zero token cost.
 *
 * Before this, the only way to reach that state was disconnect-then-bare-connect, which
 * tears down and re-opens the game session for no reason, and which an operator had to do
 * by hand through the API — there was no control for it in the UI.
 */
const AGENT = await Bun.file('src/server/lib/agent.ts').text()
const MGR = await Bun.file('src/server/lib/agent-manager.ts').text()
const ROUTES = await Bun.file('src/server/routes/profiles.ts').text()
const VIEW = await Bun.file('src/frontend/src/components/ProfileView.tsx').text()
const LIST = await Bun.file('src/frontend/src/components/ProfileList.tsx').text()

describe('the command path never depends on the LLM loop', () => {
  test('/command gates on isConnected, not running', () => {
    const route = ROUTES.slice(ROUTES.indexOf("profiles.post('/:id/command'"), ROUTES.indexOf("profiles.post('/:id/command'") + 700)
    expect(route).toContain('!agent.isConnected')
    expect(route).not.toContain('isRunning')
  })

  test('executeCommand needs only a connection', () => {
    const fn = AGENT.slice(AGENT.indexOf('async executeCommand'), AGENT.indexOf('async executeCommand') + 400)
    expect(fn).toContain('if (!this.connection)')
    expect(fn).not.toContain('this.running')
  })
})

describe('stopLoop parks without disconnecting', () => {
  test('it stops the loop and leaves the connection alone', () => {
    const fn = AGENT.slice(AGENT.indexOf('async stopLoop'), AGENT.indexOf('async stop()'))
    expect(fn).toContain('this.running = false')
    // the regression: tearing down the connection, which is what stop() does
    expect(fn).not.toContain('this.connection.disconnect()')
    expect(fn).not.toContain('this.connection = null')
  })

  test('the AbortController is REPLACED so the park is reversible', () => {
    // startLLMLoop bails immediately on an aborted signal; leaving the spent
    // controller in place would make a parked agent un-restartable.
    const fn = AGENT.slice(AGENT.indexOf('async stopLoop'), AGENT.indexOf('async stop()'))
    expect(fn).toContain('this.abortController?.abort()')
    expect(fn).toContain('this.abortController = new AbortController()')
  })

  test('the manager blocks auto-restart while parked', () => {
    const fn = MGR.slice(MGR.indexOf('async parkLLM'), MGR.indexOf('async disconnect'))
    expect(fn).toContain('this.stopRequested.add(profileId)')
    expect(fn).toContain('agent.stopLoop()')
  })
})

describe('the routes expose it', () => {
  test("single-agent connect accepts action 'park'", () => {
    expect(ROUTES).toContain("if (action === 'park')")
    expect(ROUTES).toContain('agentManager.parkLLM(id)')
  })

  test('batch accepts game-only connect and park', () => {
    expect(ROUTES).toContain("['connect_llm', 'connect', 'disconnect', 'park']")
    // a bare 'connect' must NOT start the loop
    expect(ROUTES).toContain("action !== 'connect' && profile.provider")
  })
})

describe('the UI has controls for it', () => {
  test('the agent row offers Link Only and Park', () => {
    expect(VIEW).toContain('handleLinkOnly')
    expect(VIEW).toContain('handlePark')
    expect(VIEW).toContain('Link Only')
    expect(VIEW).toContain("body: JSON.stringify({ action: 'park' })")
  })

  test('the fleet header offers Park all', () => {
    expect(LIST).toContain("batchAction('park')")
    expect(LIST).toContain("'connect_llm' | 'connect' | 'disconnect' | 'park'")
  })
})
