/**
 * pushStudioLiveReload — after a server-resolved Studio write tool
 * (`studio_apply_edits` / `studio_codemod` / `studio_create_page` /
 * `studio_set_frames`) lands a write on disk, best-effort nudge the calling
 * user's own open Site workspace (if any) to re-fetch just what changed,
 * instead of leaving the canvas silently stale until the next manual reload.
 *
 * "No open board" is a NORMAL, supported case — a headless MCP connector with
 * no browser attached — not an error condition. `hasEditorBridge` exists for
 * exactly this (`editorBridge.ts`'s own doc), so this function is a pure
 * no-op when it returns false: no promise constructed, nothing to await,
 * nothing to fail.
 *
 * Rides the SAME `toolRequest`/`toolResult` transport every browser-executed
 * `AiTool` uses (`editorBridge.ts` + `SitePage.tsx`'s
 * `useMcpWorkspaceBridge('site', executeAgentTool, ...)`), but
 * `STUDIO_LIVE_RELOAD_TOOL_NAME` is deliberately NOT a registered `AiTool`:
 * it is never listed in `tools/list` (`server/ai/mcp/server.ts` only ever
 * advertises `mcpToolsForCapabilities`'s registry), so no model can call it
 * and no external MCP client can invoke it by name — it only ever originates
 * from THIS module, after a capability-gated server tool has already
 * succeeded. See `src/admin/pages/site/agent/studioLiveReload.ts` for the
 * browser-side handler `executor.ts` dispatches it to.
 *
 * Deliberately fire-and-forget: the write already landed on disk by the time
 * this runs, so a slow or unresponsive bridge must never delay — let alone
 * fail — the tool's own result. Fail-soft throughout: any rejection (stream
 * closed mid-flight, browser navigated away) is caught and logged here, never
 * propagated into the calling tool's `AiToolOutput`.
 */
import { getEditorBridgeForUser, hasEditorBridge } from '../../editorBridge'

/** Never advertised, never discoverable — see this module's doc. */
export const STUDIO_LIVE_RELOAD_TOOL_NAME = 'studio_live_reload'

export interface StudioReloadPush {
  /** The project the write landed in — the browser ignores this push when a DIFFERENT project is currently open, so two projects can never cross-contaminate. */
  dir: string
  /** Page ids whose SOURCE CONTENT changed and should be re-read from disk. Empty when only board geometry changed (e.g. `studio_set_frames`). */
  pageIds?: readonly string[]
  /** True when `.studio/boards.json` itself changed (a new frame placed, a frame resized). */
  boardsChanged?: boolean
  /**
   * True when `.studio/comments.json` changed — the agent replied in a review
   * thread or resolved one. Kept as its own flag rather than folded into
   * `boardsChanged` because the browser handler reacts differently: comments
   * re-fetch their own file and touch NO page source, so nothing on the canvas
   * needs to re-parse. Without this, an agent's reply would sit unseen in a
   * thread the reviewer already has open on screen.
   */
  commentsChanged?: boolean
  /** Prototype interactions were written — the board re-fetches `.studio/prototype.json`. */
  prototypeChanged?: boolean
}

/**
 * The AWAITED variant, for the one caller that must not race it:
 * `studio_screenshot` reconciles the board with disk, then captures the live
 * DOM. Capturing before the canvas has re-read the files it is about to
 * photograph would return the previous frame — a stale screenshot is worse
 * than no screenshot, because it looks like evidence.
 *
 * Same fail-soft contract as {@link pushStudioLiveReload} otherwise: no open
 * board resolves immediately, and a bridge rejection is logged and swallowed
 * rather than failing the caller's own tool.
 */
export async function awaitStudioLiveReload(userId: string, push: StudioReloadPush): Promise<void> {
  const pageIds = push.pageIds ?? []
  const boardsChanged = push.boardsChanged ?? false
  const commentsChanged = push.commentsChanged ?? false
  const prototypeChanged = push.prototypeChanged ?? false
  if (pageIds.length === 0 && !boardsChanged && !commentsChanged && !prototypeChanged) return
  const bridge = hasEditorBridge(userId, 'site') ? getEditorBridgeForUser(userId, 'site') : null
  if (!bridge) return
  try {
    await bridge.callBrowser(STUDIO_LIVE_RELOAD_TOOL_NAME, { dir: push.dir, pageIds: [...pageIds], boardsChanged, commentsChanged, prototypeChanged })
  } catch (err) {
    console.error('[studio:mcp] live-reload push failed — the capture may show stale content:', err)
  }
}

export function pushStudioLiveReload(userId: string, push: StudioReloadPush): void {
  const pageIds = push.pageIds ?? []
  const boardsChanged = push.boardsChanged ?? false
  const commentsChanged = push.commentsChanged ?? false
  const prototypeChanged = push.prototypeChanged ?? false
  if (pageIds.length === 0 && !boardsChanged && !commentsChanged && !prototypeChanged) return
  if (!hasEditorBridge(userId, 'site')) return // no open board — normal for a headless MCP connector, never an error

  const bridge = getEditorBridgeForUser(userId, 'site')
  if (!bridge) return
  bridge
    .callBrowser(STUDIO_LIVE_RELOAD_TOOL_NAME, { dir: push.dir, pageIds: [...pageIds], boardsChanged, commentsChanged, prototypeChanged })
    .catch((err: unknown) => {
      console.error(
        '[studio:mcp] live-reload push failed — canvas stays stale until the next manual reload:',
        err,
      )
    })
}
