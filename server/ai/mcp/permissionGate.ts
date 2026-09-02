/**
 * In-chat permission prompts for the `claude` CLI driver.
 *
 * The CLI owns its own agent loop, so when one of ITS built-in tools needs
 * permission (reading a path outside the workspace, running a command) there is
 * no interactive terminal to ask. Headless, it just refuses — which surfaced to
 * the user as a dead end: "Claude requested permissions to read from …, but you
 * haven't granted it yet", with nowhere to say yes.
 *
 * `--permission-prompt-tool <mcp tool>` is the CLI's own mechanism for exactly
 * this: instead of prompting a TTY, it CALLS an MCP tool and does what the
 * result says. Studio already exposes an MCP server to the CLI for the turn, so
 * the prompt round-trips through machinery that already exists:
 *
 *   CLI wants a tool → calls `mcp__studio__permission_request` over HTTP
 *     → this module finds the turn's live browser bridge by connectorId
 *     → `bridge.callBrowser` emits a `toolRequest` down the open chat stream
 *     → the AgentPanel renders Allow / Deny and the user clicks
 *     → the browser POSTs to /tool-result, the promise resolves
 *     → we answer the CLI `{"behavior":"allow"}` or `{"behavior":"deny"}`
 *
 * Verified against CLI 2.1.114 (the flag is real but absent from `--help`):
 * `allow` lets the tool run, `deny` blocks it and records the attempt in the
 * result's `permission_denials`.
 *
 * ## Two invariants
 *
 * **Fail closed.** Every failure path — no gate registered, no browser
 * listening, a timeout, a malformed answer, an exception — returns `deny`. A
 * permission gate that failed open would grant silently exactly when something
 * has gone wrong, which is precisely when it must not.
 *
 * **Registered gates only.** The tool is added to `tools/list` only for a
 * connector that has a live gate, which is only ever a per-turn connector the
 * `claudeCli` driver just minted. External MCP connectors (Claude Code, Codex,
 * remote agents) never register one, so they never see the tool. It has to be
 * listed to be usable at all — the CLI validates its presence at startup and
 * aborts with "not found. Available MCP tools: …" otherwise — so being absent
 * for everyone else is the scoping mechanism.
 */
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import type { AiBrowserBridge } from '../runtime/types'

/** Unprefixed; the CLI addresses it as `mcp__studio__permission_request`. */
export const PERMISSION_REQUEST_TOOL_NAME = 'permission_request'

/**
 * The argument shape the CLI sends, confirmed by observing a real call:
 * `{"tool_name":"Read","input":{"file_path":"…"},"tool_use_id":"toolu_…"}`.
 * Snake_case because that is what the CLI emits — not this repo's convention,
 * but this is its wire format, not ours.
 */
const PermissionRequestArgsSchema = Type.Object({
  tool_name: Type.String(),
  input: Type.Optional(Type.Unknown()),
  tool_use_id: Type.Optional(Type.String()),
})

/** What the browser sends back through `/tool-result` after the user clicks. */
const PermissionDecisionSchema = Type.Object({
  behavior: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
  message: Type.Optional(Type.String()),
})
export type PermissionDecision = Static<typeof PermissionDecisionSchema>

/** Held only for the lifetime of one CLI turn. */
const gatesByConnectorId = new Map<string, AiBrowserBridge>()

/**
 * Bind this turn's browser bridge to the connector the CLI will authenticate
 * with. Returns the unregister hook the driver MUST call in its `finally` —
 * a leaked gate would let a later connector with the same id prompt through a
 * dead stream.
 */
export function registerPermissionGate(connectorId: string, bridge: AiBrowserBridge): () => void {
  gatesByConnectorId.set(connectorId, bridge)
  return () => {
    if (gatesByConnectorId.get(connectorId) === bridge) gatesByConnectorId.delete(connectorId)
  }
}

export function getPermissionGate(connectorId: string): AiBrowserBridge | null {
  return gatesByConnectorId.get(connectorId) ?? null
}

/** The `tools/list` entry, added only when `getPermissionGate` returns a bridge. */
export function permissionGateToolDefinition(): {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown> }
} {
  return {
    name: PERMISSION_REQUEST_TOOL_NAME,
    description:
      'Internal: asks the human to approve a tool call. Wired to --permission-prompt-tool and invoked by the CLI itself. Never call this directly.',
    inputSchema: PermissionRequestArgsSchema as unknown as {
      type: 'object'
      properties?: Record<string, unknown>
    },
  }
}

/**
 * Ask the human, and render the answer in the CLI's expected form: a single
 * text block whose body is `{"behavior":"allow","updatedInput":…}` or
 * `{"behavior":"deny","message":…}`.
 *
 * `updatedInput` echoes the original input unchanged — Studio asks the user to
 * approve the call the model actually proposed, and never rewrites it. The
 * field is still required on the allow path: the CLI runs the tool with
 * whatever `updatedInput` holds, so omitting it would run the tool with no
 * arguments at all.
 */
export async function runPermissionRequest(
  bridge: AiBrowserBridge,
  args: unknown,
): Promise<string> {
  if (!Value.Check(PermissionRequestArgsSchema, args)) {
    return denyPayload('Studio could not read that permission request, so it was refused.')
  }

  let decision: PermissionDecision
  try {
    const output = await bridge.callBrowser(PERMISSION_REQUEST_TOOL_NAME, {
      toolName: args.tool_name,
      input: args.input ?? {},
      toolUseId: args.tool_use_id,
    })
    if (!output.ok) {
      return denyPayload(output.error ?? 'The permission prompt could not be answered.')
    }
    if (!Value.Check(PermissionDecisionSchema, output.data)) {
      return denyPayload('Studio received a malformed permission decision, so the call was refused.')
    }
    decision = output.data
  } catch (err) {
    // A closed tab, an aborted turn, or the bridge's own timeout all land here.
    // The user never actually said yes, so this is a denial, not an error.
    console.error('[ai/mcp:permissionGate] permission prompt failed, denying:', err)
    return denyPayload('Studio could not reach the chat window to ask, so the call was refused.')
  }

  if (decision.behavior === 'allow') {
    return JSON.stringify({ behavior: 'allow', updatedInput: args.input ?? {} })
  }
  return denyPayload(decision.message ?? 'The user declined this action.')
}

function denyPayload(message: string): string {
  return JSON.stringify({ behavior: 'deny', message })
}
