/**
 * The agent's initial permission mode.
 *
 * **Bypass is the default.** Studio exists for the agent to edit the user's
 * source and drive Studio's own tools; every prompt on that path asks a
 * question whose answer is always yes, and `acceptEdits` only silenced the
 * file-edit half — every MCP tool call still raised an Allow/Deny card
 * mid-build.
 *
 * The second test is the one that protects something. It is easy to read
 * "Bypass by default" as "the agent can now do more", and that is exactly what
 * is NOT true: permission mode governs PROMPTING for an already-available
 * tool. What bounds the agent is `--tools` (a hard availability list the CLI
 * evaluates before `--permission-mode`), the subprocess `cwd`, the minted
 * connector's capabilities, and `.studio/meta.json`'s trust tier — none of
 * which this value can reach. So the invariant worth pinning is no longer
 * "never Bypass"; it is "the mode is one the driver will accept, and the
 * server still never invents it from silence" (`claudeCliPermissionMode.ts`).
 */
import { describe, expect, it } from 'bun:test'
import { agentSessionControlsInitialState } from './agentSessionControls'

describe('agentSessionControlsInitialState', () => {
  it('starts in Bypass so neither an edit nor a tool call is gated on a prompt', () => {
    expect(agentSessionControlsInitialState().agentPermissionMode).toBe('bypassPermissions')
  })

  it('starts in a mode the driver actually accepts', () => {
    // `resolvePermissionMode` refuses anything outside these four, and a
    // default it refuses would make the panel unusable on the first message.
    expect(['default', 'acceptEdits', 'plan', 'bypassPermissions']).toContain(
      agentSessionControlsInitialState().agentPermissionMode,
    )
  })

  it('leaves effort unset so the server default applies', () => {
    expect(agentSessionControlsInitialState().agentEffort).toBeNull()
  })
})
