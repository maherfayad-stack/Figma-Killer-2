/**
 * Live editor bridge for MCP.
 *
 * Browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * …) have no server implementation — their logic runs in the
 * editor app against the live store. To let an external MCP client use them,
 * the editor holds a long-lived NDJSON stream open while mounted; this module
 * keeps one bridge per user and workspace (the newest open instance wins)
 * and lets the MCP server relay a browser tool call to the correct workspace
 * before awaiting its result.
 *
 * Reuses the chat bridge machinery wholesale: `createBridge` issues the
 * `AiBrowserBridge` (whose `callBrowser` resolves when the editor POSTs back to
 * the existing `/admin/api/ai/tool-result`), and `encodeStreamEvent` frames the
 * NDJSON the editor reads with `readNdjsonStream`.
 *
 * Security: the registry is keyed by `userId` + workspace scope, so an MCP
 * connector can only ever reach the open workspace of its OWN owner.
 */
import type { AiBrowserBridge, AiStreamEvent } from '../runtime/types'
import { createBridge, encodeStreamEvent } from '../runtime'

interface EditorBridgeEntry {
  bridgeId: string
  bridge: AiBrowserBridge
  destroy: () => void
}

export type EditorBridgeScope = 'site'
const STREAM_LEASE_MS = 120_000

const byUser = new Map<string, Map<EditorBridgeScope, EditorBridgeEntry>>()

/** The live workspace bridge for a user and scope, or null when disconnected. */
export function getEditorBridgeForUser(
  userId: string,
  scope: EditorBridgeScope,
): AiBrowserBridge | null {
  return byUser.get(userId)?.get(scope)?.bridge ?? null
}

export function hasEditorBridge(userId: string, scope: EditorBridgeScope): boolean {
  return byUser.get(userId)?.has(scope) ?? false
}

/**
 * How long ONE wait window lasts before this function looks again at whether
 * it should keep waiting at all (`BRIDGE_MAX_ATTEMPTS`) — see that constant's
 * doc for why there are two of these back to back instead of one longer one.
 *
 * The registry is in-memory, so every server restart drops every registration
 * while the user's tab stays open and healthy. The browser reconnects on its
 * own (`useMcpWorkspaceBridge` retries every 3s, 15s after an auth blip), so
 * the gap is short and self-healing — but a tool that checked once and failed
 * immediately turned that few-second gap into a dead turn and a "no Studio
 * board is open" message telling the user to open a tab that was open the
 * whole time. Waiting slightly longer than one reconnect interval converts the
 * common case from a hard failure into a pause nobody notices.
 */
const BRIDGE_WAIT_MS = 4_000
const BRIDGE_POLL_MS = 250

/**
 * (mcp-tooling CHANGE C) How many `BRIDGE_WAIT_MS`-long windows this function
 * spans before giving up.
 *
 * This used to be ONE window, with the second attempt living in the SYSTEM
 * PROMPT instead: `studio_screenshot`/`studio_compare` returned "no Studio
 * board is connected" as soon as ONE `BRIDGE_WAIT_MS` window elapsed, and the
 * prompt told the model to call the same tool again if that happened — a
 * whole extra model round trip just to re-run the identical wait loop.
 * Spanning two windows IN THIS FUNCTION reproduces that same total patience
 * (what the two-call sequence bought before) inside a single tool call, so
 * one call is now sufficient for the case the prompt used to paper over.
 *
 * Still bounded, still fast on a genuine "board is closed" — `signal.aborted`
 * is checked before EVERY poll, in EVERY window, so a cancelled turn returns
 * immediately rather than sitting through the remaining attempts.
 */
const BRIDGE_MAX_ATTEMPTS = 2

/** One `BRIDGE_WAIT_MS`-bounded wait for the bridge to appear, polling every `BRIDGE_POLL_MS`. `null` on timeout OR abort. */
async function waitForEditorBridgeOnce(
  userId: string,
  scope: EditorBridgeScope,
  signal: AbortSignal | undefined,
): Promise<AiBrowserBridge | null> {
  const deadline = Date.now() + BRIDGE_WAIT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_POLL_MS))
    const bridge = getEditorBridgeForUser(userId, scope)
    if (bridge) return bridge
  }
  return null
}

/**
 * The live workspace bridge, waiting up to `BRIDGE_MAX_ATTEMPTS *
 * BRIDGE_WAIT_MS` (two ~4s windows, back to back) for a reconnecting browser
 * before answering null. Use this from any tool whose failure message would
 * otherwise tell the user to open a tab they already have open.
 */
export async function awaitEditorBridgeForUser(
  userId: string,
  scope: EditorBridgeScope,
  signal?: AbortSignal,
): Promise<AiBrowserBridge | null> {
  const immediate = getEditorBridgeForUser(userId, scope)
  if (immediate) return immediate

  for (let attempt = 0; attempt < BRIDGE_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return null
    const bridge = await waitForEditorBridgeOnce(userId, scope, signal)
    if (bridge) return bridge
  }
  return null
}

/**
 * Open the long-lived stream the editor consumes. The server pushes
 * `toolRequest` events down it whenever an MCP browser tool is invoked for this
 * user; the editor runs the tool and POSTs the result to `/tool-result`.
 */
export function createEditorBridgeStream(
  userId: string,
  scope: EditorBridgeScope,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let closeStream: (() => void) | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const encoder = new TextEncoder()

      let bridgeId = ''
      let destroyBridge = (): void => {}
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let lease: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (lease) clearTimeout(lease)
        signal.removeEventListener('abort', cleanup)
        destroyBridge()

        // Only evict if we're still the current bridge for this scope.
        const liveUserBridges = byUser.get(userId)
        if (liveUserBridges?.get(scope)?.bridgeId === bridgeId) {
          liveUserBridges.delete(scope)
          if (liveUserBridges.size === 0) byUser.delete(userId)
        }
        try {
          controller.close()
        } catch {
          /* already closed or cancelled */
        }
      }
      closeStream = cleanup

      const emit = (event: AiStreamEvent): void => {
        if (closed) return
        try {
          controller.enqueue(encodeStreamEvent(event))
        } catch {
          cleanup()
        }
      }

      const created = createBridge(emit, signal)
      bridgeId = created.bridgeId
      destroyBridge = created.destroy

      // Newest instance of this workspace wins.
      const userBridges = byUser.get(userId) ?? new Map<EditorBridgeScope, EditorBridgeEntry>()
      const previous = userBridges.get(scope)
      if (previous) previous.destroy()
      userBridges.set(scope, { bridgeId, bridge: created.bridge, destroy: destroyBridge })
      byUser.set(userId, userBridges)

      emit({ type: 'bridgeReady', bridgeId })

      // Heartbeat blank line keeps proxies from idling the connection;
      // `readNdjsonStream` skips empty lines.
      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode('\n'))
        } catch {
          cleanup()
        }
      }, 25_000)
      // Bound orphan lifetime when a proxy fails to propagate a closed
      // downstream connection. The client reconnect loop restores the bridge.
      lease = setTimeout(cleanup, STREAM_LEASE_MS)

      if (signal.aborted) cleanup()
      else signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() {
      // Bun cancels the response body when the browser tab/context closes, but
      // that transport cancellation does not abort the server Request signal.
      // Tear down the heartbeat + registry entry from either lifecycle signal.
      closeStream?.()
      closeStream = null
    },
  })
}
