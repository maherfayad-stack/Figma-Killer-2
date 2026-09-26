/**
 * P1-D (ERR-19) — while a tab has a project open, a file changed on disk by
 * someone other than Studio reaches that tab as a `studio_live_reload` push
 * naming it; Studio's own writes, and files no frame is built from, do not.
 *
 * End to end on the server: a real project directory, the real watcher, and a
 * real editor-bridge stream standing in for the browser tab — the same
 * transport `liveReloadPush.test.ts` proves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { withProjectWriteLock } from '../../handlers/studio/projectWriteLock'
import { resolveBridgeToolResult } from '../runtime'
import { createEditorBridgeStream, editorBridgeScope } from './editorBridge'
import { outsideChangesToPush, retainOutsideEditReload } from './outsideEditReload'
import { STUDIO_LIVE_RELOAD_TOOL_NAME } from './tools/studio/liveReloadPush'

type BridgeEvent = { type: string; [k: string]: unknown }

let dir: string
const cleanups: (() => void)[] = []
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const write = (rel: string, contents: string) => {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-edit-'))
  write('pages/Home.tsx', 'export default function Home() { return <p>Home</p> }\n')
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await sleep(50)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A tab with `dir` open: its bridge stream, and every event it receives. */
async function openTab(): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  const ctrl = new AbortController()
  const userId = `u_outside_${Math.random().toString(36).slice(2)}`
  const release = retainOutsideEditReload(dir)
  const reader = createEditorBridgeStream(userId, editorBridgeScope(dir), ctrl.signal, release).getReader()
  cleanups.push(() => ctrl.abort())
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done || !value) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line) as BridgeEvent)
    }
  })()
  await sleep(200)
  return events
}

const reloadRequests = (events: readonly BridgeEvent[]) =>
  events.filter((event) => event.type === 'toolRequest' && event.toolName === STUDIO_LIVE_RELOAD_TOOL_NAME)

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(25)
}

describe('an edit made outside Studio reaches the open board', () => {
  it('pushes the changed file to the tab that has the project open', async () => {
    const events = await openTab()
    write('pages/Home.tsx', 'export default function Home() { return <p>Edited in VS Code</p> }\n')
    await waitFor(() => reloadRequests(events).length > 0)

    const [request] = reloadRequests(events)
    expect(request?.input).toEqual({
      dir,
      pageIds: [],
      boardsChanged: false,
      commentsChanged: false,
      diskChanged: { files: ['pages/Home.tsx'] },
    })
    // The tab answers, as `runStudioLiveReload` does.
    const bridgeId = events.find((event) => event.type === 'bridgeReady')!.bridgeId as string
    expect(resolveBridgeToolResult(bridgeId, request!.requestId as string, { ok: true, data: { applied: true } })).toBe(true)
  })

  it("does not push Studio's own write — its writer already re-reads the board", async () => {
    const events = await openTab()
    await withProjectWriteLock(dir, () => write('pages/Home.tsx', 'export default function Home() { return <p>Studio</p> }\n'))
    await sleep(1_000)
    expect(reloadRequests(events)).toEqual([])
  })

  it('does not push a change to a file no frame is built from', async () => {
    const events = await openTab()
    write('README.md', '# notes\n')
    write('package-lock.json', '{}\n')
    await sleep(1_000)
    expect(reloadRequests(events)).toEqual([])
  })
})

describe('outsideChangesToPush', () => {
  it('keeps outside changes to board inputs, and answers "everything" for an overflow', () => {
    expect(
      outsideChangesToPush({
        overflow: false,
        changes: [
          { rel: 'pages/Home.tsx', exists: true, origin: 'outside' },
          { rel: 'src/copy.json', exists: true, origin: 'outside' },
          { rel: 'src/Card.module.css', exists: false, origin: 'outside' },
          { rel: 'pages/About.tsx', exists: true, origin: 'studio' },
          { rel: 'public/logo.png', exists: true, origin: 'outside' },
          { rel: '.studio/canvas/layer-1.tsx', exists: true, origin: 'outside' },
        ],
      }),
    ).toEqual(['pages/Home.tsx', 'src/copy.json', 'src/Card.module.css', '.studio/canvas/layer-1.tsx'])
    expect(outsideChangesToPush({ overflow: false, changes: [{ rel: 'pages/Home.tsx', exists: true, origin: 'studio' }] })).toBeNull()
    expect(outsideChangesToPush({ overflow: true, changes: [] })).toEqual([])
  })
})
