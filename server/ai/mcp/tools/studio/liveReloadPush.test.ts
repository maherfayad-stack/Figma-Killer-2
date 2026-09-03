/**
 * pushStudioLiveReload — the server-side half of mcp-tooling's live-reload
 * bridge. Reuses `editorBridge.test.ts`'s own stream-registration pattern
 * (the two modules share the exact same registry) so this test proves the
 * real transport, not a mock of it.
 */
import { describe, expect, it } from 'bun:test'
import { resolveBridgeToolResult } from '../../../runtime'
import { createEditorBridgeStream, getEditorBridgeForUser } from '../../editorBridge'
import { pushStudioLiveReload, STUDIO_LIVE_RELOAD_TOOL_NAME } from './liveReloadPush'

const dec = new TextDecoder()

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
    expect(() => pushStudioLiveReload(userId, { dir: '/tmp/proj', pageIds: ['home'] })).not.toThrow()
  })

  it('is a no-op even WITH an open bridge when there is nothing to push (no pageIds, no changed flags)', async () => {
    const userId = `u_noop_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, 'site', ctrl.signal).getReader()
    await readUntil(reader, (e) => e.type === 'bridgeReady')

    pushStudioLiveReload(userId, { dir: '/tmp/proj', pageIds: [] })

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
    const stream = createEditorBridgeStream(userId, 'site', ctrl.signal)
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: '/tmp/proj', pageIds: ['home', 'about'], boardsChanged: true })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.toolName).toBe(STUDIO_LIVE_RELOAD_TOOL_NAME)
    expect(toolRequest.input).toEqual({ dir: '/tmp/proj', pageIds: ['home', 'about'], boardsChanged: true, commentsChanged: false, prototypeChanged: false })

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
    const reader = createEditorBridgeStream(userId, 'site', ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: '/tmp/proj', commentsChanged: true })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.input).toEqual({
      dir: '/tmp/proj',
      pageIds: [],
      boardsChanged: false,
      commentsChanged: true,
      prototypeChanged: false,
    })
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, { ok: true, data: null })

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('pushes a prototype-only change, which touches no page and no board', async () => {
    // Same reason the comments-only case above exists: wiring an interaction
    // writes .studio/prototype.json and nothing else, so without a flag of its
    // own the push is dropped by the "nothing to do" guard and the connector
    // the user is watching never draws the link the agent just made.
    const userId = `u_prototype_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, 'site', ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: '/tmp/proj', prototypeChanged: true })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.input).toEqual({
      dir: '/tmp/proj',
      pageIds: [],
      boardsChanged: false,
      commentsChanged: false,
      prototypeChanged: true,
    })
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, { ok: true, data: null })

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('defaults both changed-flags to false in the pageIds-only case', async () => {
    const userId = `u_default_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, 'site', ctrl.signal).getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    pushStudioLiveReload(userId, { dir: '/tmp/proj', pageIds: ['home'] })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.input).toEqual({ dir: '/tmp/proj', pageIds: ['home'], boardsChanged: false, commentsChanged: false, prototypeChanged: false })
    resolveBridgeToolResult(bridgeId, toolRequest.requestId as string, { ok: true, data: null })

    ctrl.abort()
    await reader.read().catch(() => {})
  })

  it('never resolves synchronously — getEditorBridgeForUser still reports the SAME bridge instance right after the push call', () => {
    const userId = `u_sync_${Math.floor(performance.now())}`
    const ctrl = new AbortController()
    createEditorBridgeStream(userId, 'site', ctrl.signal)
    const before = getEditorBridgeForUser(userId, 'site')
    pushStudioLiveReload(userId, { dir: '/tmp/proj', pageIds: ['home'] })
    expect(getEditorBridgeForUser(userId, 'site')).toBe(before)
    ctrl.abort()
  })
})
