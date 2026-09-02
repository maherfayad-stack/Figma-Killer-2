import { describe, it, expect } from 'bun:test'
import type { AiBrowserBridge, AiToolOutput } from '../runtime/types'
import {
  PERMISSION_REQUEST_TOOL_NAME,
  getPermissionGate,
  permissionGateToolDefinition,
  registerPermissionGate,
  runPermissionRequest,
} from './permissionGate'

/** The exact argument shape the CLI sends, captured from a real invocation. */
const CLI_ARGS = {
  tool_name: 'Read',
  input: { file_path: 'C:\\outside\\note.txt' },
  tool_use_id: 'toolu_01SVkrSprbZ6mrRCG7YVek7X',
}

function bridgeReturning(output: AiToolOutput): AiBrowserBridge {
  return { callBrowser: async () => output }
}

function decision(raw: string): { behavior: string; message?: string; updatedInput?: unknown } {
  return JSON.parse(raw)
}

describe('permission gate registry', () => {
  it('is scoped to the registering connector and released by the returned hook', () => {
    const bridge = bridgeReturning({ ok: true, data: { behavior: 'allow' } })
    const release = registerPermissionGate('connector-a', bridge)

    expect(getPermissionGate('connector-a')).toBe(bridge)
    // The scoping mechanism: another connector — an external MCP client — sees
    // no gate, so the tool is never advertised to it.
    expect(getPermissionGate('connector-b')).toBeNull()

    release()
    expect(getPermissionGate('connector-a')).toBeNull()
  })

  it('releasing a superseded registration does not evict the newer one', () => {
    const first = bridgeReturning({ ok: true, data: { behavior: 'allow' } })
    const second = bridgeReturning({ ok: true, data: { behavior: 'deny' } })
    const releaseFirst = registerPermissionGate('connector-c', first)
    registerPermissionGate('connector-c', second)

    releaseFirst()

    expect(getPermissionGate('connector-c')).toBe(second)
  })

  it('advertises the tool under the name the driver points --permission-prompt-tool at', () => {
    // The CLI resolves `mcp__studio__<name>` against tools/list at startup and
    // aborts if it is missing, so this name is load-bearing on both sides.
    expect(permissionGateToolDefinition().name).toBe(PERMISSION_REQUEST_TOOL_NAME)
    expect(permissionGateToolDefinition().inputSchema.type).toBe('object')
  })
})

describe('runPermissionRequest', () => {
  it('allows, echoing the original input as updatedInput', async () => {
    let seen: unknown
    const bridge: AiBrowserBridge = {
      callBrowser: async (toolName, input) => {
        seen = { toolName, input }
        return { ok: true, data: { behavior: 'allow' } }
      },
    }

    const result = decision(await runPermissionRequest(bridge, CLI_ARGS))

    expect(result.behavior).toBe('allow')
    // The CLI runs the tool with whatever `updatedInput` holds — dropping it
    // would run the tool with no arguments at all.
    expect(result.updatedInput).toEqual(CLI_ARGS.input)
    expect(seen).toEqual({
      toolName: PERMISSION_REQUEST_TOOL_NAME,
      input: { toolName: 'Read', input: CLI_ARGS.input, toolUseId: CLI_ARGS.tool_use_id },
    })
  })

  it('denies with the user-facing message when the user declines', async () => {
    const bridge = bridgeReturning({ ok: true, data: { behavior: 'deny', message: 'You declined this action.' } })

    const result = decision(await runPermissionRequest(bridge, CLI_ARGS))

    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('You declined this action.')
  })

  // Every one of these is a path where something went wrong rather than the
  // user saying yes. A gate that failed OPEN would grant silently at exactly
  // the moment it must not.
  describe('fails closed', () => {
    it('when the request arguments are unreadable', async () => {
      const bridge = bridgeReturning({ ok: true, data: { behavior: 'allow' } })

      const result = decision(await runPermissionRequest(bridge, { nonsense: true }))

      expect(result.behavior).toBe('deny')
    })

    it('when the browser reports the tool failed', async () => {
      const bridge = bridgeReturning({ ok: false, error: 'no workspace' })

      expect(decision(await runPermissionRequest(bridge, CLI_ARGS)).behavior).toBe('deny')
    })

    it('when the browser answers with a shape that is not a decision', async () => {
      const bridge = bridgeReturning({ ok: true, data: { behaviour: 'allow' } })

      expect(decision(await runPermissionRequest(bridge, CLI_ARGS)).behavior).toBe('deny')
    })

    it('when the behavior is a value outside the union', async () => {
      const bridge = bridgeReturning({ ok: true, data: { behavior: 'ALLOW' } })

      expect(decision(await runPermissionRequest(bridge, CLI_ARGS)).behavior).toBe('deny')
    })

    it('when the bridge throws — a closed tab, an aborted turn, or a timeout', async () => {
      const bridge: AiBrowserBridge = {
        callBrowser: async () => {
          throw new Error('AI chat stream ended before tool result arrived.')
        },
      }

      const result = decision(await runPermissionRequest(bridge, CLI_ARGS))

      expect(result.behavior).toBe('deny')
      expect(result.message).toContain('could not reach the chat window')
    })
  })
})
