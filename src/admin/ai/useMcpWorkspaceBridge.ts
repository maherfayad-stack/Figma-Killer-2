/**
 * Keep one workspace-scoped MCP browser bridge open while its editor is
 * mounted.
 *
 * The bridge is registered server-side under `site:${projectKey}` (W10), so
 * the connection has to say WHICH project this tab is showing — otherwise two
 * tabs on two projects share one slot and the agent's tool calls reach
 * whichever registered last. The dir is read through a getter, not passed as
 * a value: `studioWriteDir()` is module state that settles after the first
 * load completes, and every other Studio client call reads it the same way
 * at call time. Each reconnect (≤120s, the server's stream lease) therefore
 * picks up the current project without this hook needing to be reactive.
 */
import { useEffect } from 'react'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { readNdjsonStream } from './ndjsonStream'
import { postToolResult } from './toolResultApi'

const MCP_BRIDGE_PATH = '/admin/api/ai/editor-bridge'
const RECONNECT_DELAY_MS = 3000
// Auth failures (logged out / brief blip during a server restart) back off
// longer but still retry so the bridge self-heals once the session is valid.
const AUTH_RETRY_DELAY_MS = 15000

const BridgeEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('bridgeReady'), bridgeId: Type.String() }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
])

/** The workspace KIND. The project half of the server-side scope is derived from the dir this hook sends. */
const WORKSPACE_KIND = 'site'

/** Reads the project dir this tab currently has open, at connect time. `null` before any project has loaded — the bridge simply waits and retries. */
export type McpWorkspaceDirResolver = () => string | null

export type McpToolDispatcher = (
  toolName: string,
  input: unknown,
) => Promise<AiToolOutput>
export type McpAfterSuccessfulTool = () => Promise<void>

/**
 * Run one relayed tool and any workspace-specific persistence step. Keeping
 * the persistence callback inside the same try/catch is deliberate: a tool is
 * not successful until its mutation is durably saved for the MCP caller's
 * next request.
 */
export async function executeMcpBridgeRequest(
  dispatchTool: McpToolDispatcher,
  toolName: string,
  input: unknown,
  afterSuccessfulTool?: McpAfterSuccessfulTool,
): Promise<AiToolOutput> {
  try {
    const result = await dispatchTool(toolName, input)
    if (result.ok && afterSuccessfulTool) await afterSuccessfulTool()
    return result
  } catch (err) {
    return { ok: false, error: getErrorMessage(err, 'Tool failed.') }
  }
}

type McpBridgeConnectionOutcome = 'auth' | 'transient'

/**
 * Run one editor-bridge connection. Every attempt owns a fresh controller;
 * its signal is also linked to the hook lifetime so unmount still tears down
 * the current request. Leaving this function aborts the connection, which is
 * essential when tool-result delivery fails: the server waiter must reject
 * now instead of hanging until its 90-second timeout.
 */
export async function runMcpWorkspaceBridgeConnection(
  projectDir: string | null,
  dispatchTool: McpToolDispatcher,
  afterSuccessfulTool: McpAfterSuccessfulTool | undefined,
  lifecycleSignal: AbortSignal,
): Promise<McpBridgeConnectionOutcome> {
  // No project open yet (a tab that has not finished its first load). The
  // server would refuse the connection anyway — it will not register a bridge
  // on a guessed project — so wait for the next retry instead of spending a
  // request to be told so.
  if (!projectDir) return 'transient'

  const connectionController = new AbortController()
  const signal = AbortSignal.any([lifecycleSignal, connectionController.signal])
  let bridgeId = ''

  try {
    const query = `scope=${WORKSPACE_KIND}&dir=${encodeURIComponent(projectDir)}`
    const res = await fetch(`${MCP_BRIDGE_PATH}?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/x-ndjson' },
      signal,
    })
    if (res.status === 401 || res.status === 403) return 'auth'
    if (!res.ok || !res.body) return 'transient'

    for await (const event of readNdjsonStream(res.body.getReader(), BridgeEventSchema)) {
      signal.throwIfAborted()
      if (event.type === 'bridgeReady') {
        bridgeId = event.bridgeId
        console.info(`[mcp-workspace-bridge:${WORKSPACE_KIND}] connected`)
        continue
      }

      const result = await executeMcpBridgeRequest(
        dispatchTool,
        event.toolName,
        event.input,
        afterSuccessfulTool,
      )
      await postToolResult(bridgeId, event.requestId, result, signal)
    }
    return 'transient'
  } finally {
    connectionController.abort()
  }
}

export function useMcpWorkspaceBridge(
  resolveProjectDir: McpWorkspaceDirResolver,
  dispatchTool: McpToolDispatcher,
  afterSuccessfulTool?: McpAfterSuccessfulTool,
): void {
  useEffect(() => {
    const lifecycleController = new AbortController()
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    // Returns 'auth' when the server rejected on auth (back off longer, but
    // keep retrying). Returns 'transient' when the stream ended or was not
    // ready. Unmount is the only permanent stop condition.
    async function connectOnce(): Promise<McpBridgeConnectionOutcome> {
      return runMcpWorkspaceBridgeConnection(
        resolveProjectDir(),
        dispatchTool,
        afterSuccessfulTool,
        lifecycleController.signal,
      )
    }

    async function loop(): Promise<void> {
      while (!stopped) {
        let delay = RECONNECT_DELAY_MS
        try {
          const outcome = await connectOnce()
          if (outcome === 'auth') delay = AUTH_RETRY_DELAY_MS
        } catch (err) {
          if (stopped || lifecycleController.signal.aborted) break
          console.error(`[mcp-workspace-bridge:${WORKSPACE_KIND}] stream error (will retry):`, err)
        }
        if (stopped) break
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, delay)
        })
      }
    }

    void loop()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      lifecycleController.abort()
    }
  }, [resolveProjectDir, dispatchTool, afterSuccessfulTool])
}
