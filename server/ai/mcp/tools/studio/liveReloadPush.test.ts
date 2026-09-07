/**
 * pushStudioLiveReload — the server-side half of mcp-tooling's live-reload
 * bridge. Reuses `editorBridge.test.ts`'s own stream-registration pattern
 * (the two modules share the exact same registry) so this test proves the
 * real transport, not a mock of it.
 */
import { describe, expect, it } from 'bun:test'
import { resolveBridgeToolResult } from '../../../runtime'
import { createEditorBridgeStream, editorBridgeScope, getEditorBridgeForUser } from '../../editorBridge'
import { pushStudioLiveReload, STUDIO_LIVE_RELOAD_TOOL_NAME } from './liveReloadPush'

const dec = new TextDecoder()

/**
 * The project every push in this file is about. Since W10 a bridge is
 * registered under `site:${projectKey}`, so the tab has to be registered for
 * the SAME project the push names or the lookup finds nothing — which is the
 * point: a tab on another project is never nudged about a write it did not
 * make.
 */
const PROJECT_DIR = '/tmp/proj'
const OTHER_PROJECT_DIR = '/tmp/other-proj'
const SCOPE = editorBridgeScope(PROJECT_DIR)

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { type: string; [k: string]: unknown }) => boolean,
): Promise<{ type: string; [k: string]: unknown }> {
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stream ended before predicate matched')
    buffer += dec.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const event = JSON.parse(trimmed)
      if (predicate(event)) return event
    }
  }
}

describe('pushStudioLiveReload', () => {
  it('is a silent no-op when the user has no open Site workspace — never throws', () => {
    const userId = `u_no_bridge_${Math.floor(performance.now())}`
    expect(() => pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: ['home'] })).not.toThrow()
  })

  it('is a no-op even WITH an open bridge when there is nothing to push (no pageIds, no changed flags)', async () => {
    const userId = `u_noop_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, SCOPE, ctrl.signal).getReader()
    await readUntil(reader, (e) => e.type === 'bridgeReady')

    pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: [] })

    // No toolRequest should ever arrive — race it against a short read with a
    // manual timeout rather than asserting a negative on an unbounded stream.
    const raced = await Promise.race([
      readUntil(reader, (e) => e.type === 'toolRequest'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(raced).toBe('timeout')

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('pushes a studio_live_reload toolRequest with the dir/pageIds/boardsChanged payload, over the SAME transport every browser tool uses', async () => {
    const userId = `u_push_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const stream = createEditorBridgeStream(userId, SCOPE, ctrl.signal)
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: ['home', 'about'], boardsChanged: true })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.toolName).toBe(STUDIO_LIVE_RELOAD_TOOL_NAME)
    expect(toolRequest.input).toEqual({ dir: PROJECT_DIR, pageIds: ['home', 'about'], boardsChanged: true, commentsChanged: false })

    // Resolve it like the browser would — proves the push is a real,
    // completable round trip, not a fire-into-the-void with no receiver.
    const requestId = toolRequest.requestId as string
    const matched = resolveBridgeToolResult(bridgeId, requestId, { ok: true, data: { applied: true, failed: [] } })
    expect(matched).toBe(true)

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('pushes on a comments-only change, with no pages to re-parse', async () => {
    // An agent replying in a review thread touches no page source. Without a
    // flag of its own the push would be dropped by the "nothing to do" guard,
    // and the reply would sit unseen in a thread the reviewer already has open.
    const userId = `u_comments_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, SCOPE, ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: PROJECT_DIR, commentsChanged: true })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.input).toEqual({
      dir: PROJECT_DIR,
      pageIds: [],
      boardsChanged: false,
      commentsChanged: true,
    })
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, { ok: true, data: null })

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('defaults both changed-flags to false in the pageIds-only case', async () => {
    const userId = `u_default_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, SCOPE, ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: ['home'] })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.input).toEqual({ dir: PROJECT_DIR, pageIds: ['home'], boardsChanged: false, commentsChanged: false })
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, { ok: true, data: null })

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('never resolves synchronously — getEditorBridgeForUser still reports the SAME bridge instance right after the push call', () => {
    const userId = `u_sync_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    createEditorBridgeStream(userId, SCOPE, ctrl.signal)
    const before = getEditorBridgeForUser(userId, SCOPE)
    pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: ['home'] })
    expect(getEditorBridgeForUser(userId, SCOPE)).toBe(before)
    ctrl.abort()
  })

  it('never reaches a tab open on a DIFFERENT project', async () => {
    // The bug this closes: one bridge slot per user meant a write in project A
    // was relayed into whichever tab registered last, which then reloaded
    // pages that had not changed — and, worse, believed it had.
    const userId = `u_other_project_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(
      userId,
      editorBridgeScope(OTHER_PROJECT_DIR),
      ctrl.signal,
    ).getReader()
    await readUntil(reader, (e) => e.type === 'bridgeReady')

    pushStudioLiveReload(userId, { dir: PROJECT_DIR, pageIds: ['home'] })

    const raced = await Promise.race([
      readUntil(reader, (e) => e.type === 'toolRequest'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(raced).toBe('timeout')

    ctrl.abort()
    await reader.read().catch(() => {})
  })
})
