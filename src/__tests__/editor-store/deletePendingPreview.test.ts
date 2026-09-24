/**
 * ERR-22 — Delete on the preview a still-writing ⌘D just painted.
 *
 * The preview has a client-minted id that names nothing in the user's source,
 * so a Delete cannot act on it directly. It used to be REFUSED with "Still
 * writing your last change — try again in a moment", which asked the person to
 * wait and press Delete again for something the editor can do in order: queue
 * the Delete behind the write that made the preview, then aim it at the element
 * that write actually created (`createdNodeIds`).
 *
 * Confirmed to fail without the fix: with `deleteNode` stripping pending ids
 * (`excludePendingOptimisticTargets`, the pre-P3-A behaviour) the second POST
 * never happens and the warning toast appears.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { isPendingOptimisticNodeId, resetOptimisticPreviewTracking } from '@site/store/slices/site/structuralOptimism'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import type { PageNode } from '@core/page-tree'
import { makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const FILE = 'app/page.tsx'
const at = (line: number) => `${FILE}:${line}:5`
const ROOT = 'page-1:body'

function textNode(id: string): PageNode {
  return { id, moduleId: 'base.text', props: { text: id }, breakpointOverrides: {}, children: [], classIds: [] }
}

/**
 * `at(3)` is the element duplicated. `at(4)` stands for the copy the write
 * creates — seeded up front, because this harness mounts no persistence layer
 * to run the resync that would bring it in.
 */
function studioSite() {
  const nodes: Record<string, PageNode> = {
    [ROOT]: { id: ROOT, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [at(3), at(4)], classIds: [] },
    [at(3)]: textNode(at(3)),
    [at(4)]: textNode(at(4)),
  }
  return makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: ROOT, nodes })] })
}

const store = () => useEditorStore.getState()

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let realFetch: typeof globalThis.fetch
let saveBodies: Array<{ edits: Array<{ kind: string; nodeId: string }> }>
let releaseFirstSave: () => void

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** The first /save (the duplicate) is held until released; it reports the copy it made. Every later one lands. */
function stubFetch(): void {
  let gate: Promise<void> = new Promise((resolve) => {
    releaseFirstSave = resolve
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      const body = JSON.parse(String(init?.body)) as { edits: Array<{ kind: string; nodeId: string }> }
      saveBodies.push(body)
      if (body.edits[0]?.kind === 'duplicate') {
        await gate
        gate = Promise.resolve()
        return json({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE], createdNodeIds: [at(4)] })
      }
      return json({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE] })
    }
    return json({ ok: true, narrow: false })
  }) as typeof globalThis.fetch
}

beforeEach(() => {
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
  __resetToastBusForTests()
  realFetch = globalThis.fetch
  saveBodies = []
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
})

afterEach(async () => {
  releaseFirstSave?.()
  await waitFor(() => !isStructuralCommitInFlight()).catch(() => {})
  globalThis.fetch = realFetch
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
})

describe('ERR-22 — Delete on a still-writing preview', () => {
  it('is queued behind the write and deletes the element that write created — no "Still writing" toast', async () => {
    stubFetch()
    let toasts: readonly Toast[] = []
    const unsubscribe = subscribeToasts((snapshot) => {
      toasts = snapshot
    })
    store().loadSite(studioSite())
    store().setActivePage('page-1')

    store().duplicateNode(at(3))
    await waitFor(() => saveBodies.length === 1)
    const page = store().site!.pages.find((p) => p.id === 'page-1')!
    const previewId = Object.keys(page.nodes).find((id) => isPendingOptimisticNodeId(id))
    expect(previewId).toBeDefined()

    // Delete pressed on the preview while its own write is on the wire.
    store().deleteNode(previewId!)
    expect(saveBodies).toHaveLength(1)

    releaseFirstSave()
    await waitFor(() => saveBodies.length === 2)
    await waitFor(() => !isStructuralCommitInFlight())

    expect(saveBodies[1]!.edits).toEqual([{ kind: 'delete', nodeId: at(4) }])
    expect(toasts.map((toast) => toast.title)).not.toContain('Still writing your last change')
    unsubscribe()
  })
})
