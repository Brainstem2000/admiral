/**
 * The v2 group-form rewrite must only fire when the flat name really exists.
 *
 * `tools.ts` rewrites `shipping(action=X)` to the flat `shipping_X` and DELETES
 * the action argument. That is unrecoverable when the flat name is not a real
 * route: the call reaches the server as a bare `shipping` with no action and
 * comes back `unknown_command`, with nothing left to fall back to.
 *
 * Cass Margin hit this on 2026-09-03. `shipping(action=active)` — a call that
 * works perfectly well in its group form — was rewritten to the non-existent
 * `shipping_active`, and she burned ~10 minutes and a loop-break on it while
 * standing on a deliverable freight contract.
 *
 * These assertions pin the two halves of the guard: the actions that DO have a
 * flat route (so the rewrite must still happen, since the group form is what
 * lib_v2 cannot dispatch) and the one that does not (so it must be left alone).
 */
import { test, expect, describe } from 'bun:test'
import { hasLibV2Route, libV2GroupActions } from '../src/server/lib/connections/lib_v2'

describe('lib_v2 route index', () => {
  test('flat names that exist are reported present', () => {
    // These are the shipping verbs the fleet actually uses; the rewrite is
    // correct for them and must keep firing.
    for (const name of ['shipping_deliver', 'shipping_accept', 'shipping_list']) {
      expect(hasLibV2Route(name)).toBe(true)
    }
  })

  test('shipping_active is NOT a route — the group form must survive', () => {
    // The regression itself. If this ever flips to true the guard is moot, but
    // if the rewrite stops consulting it we are back to unknown_command.
    expect(hasLibV2Route('shipping_active')).toBe(false)
  })

  test('a nonsense name is absent rather than throwing', () => {
    expect(hasLibV2Route('shipping_definitely_not_a_verb')).toBe(false)
    expect(hasLibV2Route('')).toBe(false)
  })

  test('battle(action=reload) maps to the bare reload command', () => {
    // tools.ts special-cases this one; if `reload` ever stops resolving, that
    // special case is silently dead.
    expect(hasLibV2Route('reload')).toBe(true)
  })
})

describe('group action enumeration', () => {
  // Backs the local refusal for a group call that arrives with no action. If
  // this returns nothing the guard silently disables itself and the agent is
  // back to burning loop-breaks discovering the verb list from the server.
  test('shipping exposes the verbs the client library knows', () => {
    const actions = libV2GroupActions('shipping')
    for (const verb of ['quote', 'post', 'list', 'get', 'track',
                        'profile', 'pay_debt', 'accept', 'deliver', 'return', 'cancel']) {
      expect(actions).toContain(verb)
    }
  })

  test('the list is BEST-EFFORT: the lib lags the live server', () => {
    // The server (spec v0.547.0) accepts `shipping(action="active")` — verified
    // live on Cass Margin's own connection, it returns her in-transit
    // shipments. The bundled lib does not carry it, which is also why
    // hasLibV2Route('shipping_active') is false above.
    //
    // So the refusal guard must present its list as "the verbs we know" and
    // never as an exhaustive one, or it will confidently tell an agent that a
    // working call is invalid. If this assertion ever flips, the lib has caught
    // up and the hedge in the message can be dropped.
    expect(libV2GroupActions('shipping')).not.toContain('active')
  })

  test('the spacemolt_ prefix is accepted and stripped', () => {
    expect(libV2GroupActions('spacemolt_shipping')).toEqual(libV2GroupActions('shipping'))
  })

  test('other groups enumerate too, and an unknown group is empty', () => {
    expect(libV2GroupActions('facility').length).toBeGreaterThan(0)
    expect(libV2GroupActions('market').length).toBeGreaterThan(0)
    expect(libV2GroupActions('not_a_real_group')).toEqual([])
  })
})
