/**
 * The agent's initial permission mode.
 *
 * "Auto" (`acceptEdits`) is the working default: Studio exists for the agent to
 * edit the user's source, so a per-edit prompt asks a question whose answer is
 * always yes and turns a multi-edit build into a click-through.
 *
 * The test that actually protects something is the second one. D5 §11.5 rail 1
 * says Bypass must never persist, and the mechanism is entirely "the initial
 * value is not Bypass, and nothing reads the mode from storage." That rail used
 * to be enforced only by the literal `'default'` sitting in the initializer —
 * so moving the default at all could have quietly broken it. Pin the invariant
 * itself, not the incidental value it used to have.
 */
import { describe, expect, it } from 'bun:test'
import { agentSessionControlsInitialState } from './agentSessionControls'

describe('agentSessionControlsInitialState', () => {
  it('starts in Auto so the agent is not gated on a prompt per edit', () => {
    expect(agentSessionControlsInitialState().agentPermissionMode).toBe('acceptEdits')
  })

  it('never starts in bypassPermissions — D5 §11.5 rail 1', () => {
    expect(agentSessionControlsInitialState().agentPermissionMode).not.toBe('bypassPermissions')
  })

  it('leaves effort unset so the server default applies', () => {
    expect(agentSessionControlsInitialState().agentEffort).toBeNull()
  })
})
