/**
 * `loadSite` — history preservation across a reload
 * (`STUDIO-FIGMA-PARITY-PLAN.md` 0.2 / audit E2, item (c)).
 *
 * Before this fix, EVERY `loadSite()` call — including the one every
 * structural edit (move/delete/insert) fires via `requestCmsSiteReload()` —
 * wiped `_historyPast`/`_historyFuture` unconditionally. A single drag-reorder
 * in the layers tree destroyed the undo stack for every unrelated edit made
 * before it.
 *
 * `historyPreservation.ts`'s fix: keep the stack intact when every node id any
 * stored patch references still exists in the freshly-loaded site (the common
 * case — a structural edit only shifts ids inside the file(s) it touched);
 * fall back to wiping (today's old, always-safe behavior) when it doesn't.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

function getStore() {
  return useEditorStore.getState()
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
})

describe('loadSite — history survives a reload when every referenced node id still resolves', () => {
  it('keeps BOTH _historyPast and _historyFuture (same array references) when nothing was shifted', () => {
    const site = getStore().createSite('Test')
    const rootId = site.pages[0].rootNodeId
    const nodeId = getStore().insertNode('base.text', { text: 'a' }, rootId)
    getStore().updateNodeProps(nodeId, { text: 'b' })
    getStore().undo() // one entry in the past, one in the future — proves BOTH survive
    const pastBefore = getStore()._historyPast
    const futureBefore = getStore()._historyFuture
    expect(pastBefore.length).toBeGreaterThan(0)
    expect(futureBefore.length).toBeGreaterThan(0)

    // The "reload" is the CURRENT live site handed back to loadSite — every
    // node id this history references is still a key in it, exactly the
    // shape a structural edit that didn't shift THIS node's file produces.
    const reloaded = structuredClone(getStore().site!)
    getStore().loadSite(reloaded)

    expect(getStore()._historyPast).toBe(pastBefore)
    expect(getStore()._historyFuture).toBe(futureBefore)
    expect(getStore().canUndo).toBe(true)
    expect(getStore().canRedo).toBe(true)
  })

  it('still ends any in-progress coalescing burst on a preserving reload', () => {
    const site = getStore().createSite('Test')
    const rootId = site.pages[0].rootNodeId
    const nodeId = getStore().insertNode('base.text', { text: 'a' }, rootId)
    getStore().updateNodeProps(nodeId, { text: 'b' }) // opens a coalescing burst
    expect(getStore()._historyCoalesceKey).not.toBeNull()

    getStore().loadSite(structuredClone(getStore().site!))

    expect(getStore()._historyCoalesceKey).toBeNull()
  })

  it('always clears hasUnsavedChanges, whether or not history survives — the reload always replaces `site` wholesale', () => {
    const site = getStore().createSite('Test')
    const rootId = site.pages[0].rootNodeId
    const nodeId = getStore().insertNode('base.text', { text: 'a' }, rootId)
    getStore().updateNodeProps(nodeId, { text: 'b' })
    expect(getStore().hasUnsavedChanges).toBe(true)

    getStore().loadSite(structuredClone(getStore().site!))

    expect(getStore().hasUnsavedChanges).toBe(false)
  })

  it('is a safe no-op on a project\'s very first load (empty history is vacuously safe)', () => {
    const site = makeSite()
    getStore().loadSite(site)

    expect(getStore()._historyPast).toEqual([])
    expect(getStore()._historyFuture).toEqual([])
    expect(getStore().canUndo).toBe(false)
    expect(getStore().canRedo).toBe(false)
  })
})

describe('loadSite — history is wiped when a referenced node id no longer resolves', () => {
  it('falls back to clearing _historyPast/_historyFuture when the incoming site is a genuinely different document', () => {
    const site = getStore().createSite('Test')
    const rootId = site.pages[0].rootNodeId
    const nodeId = getStore().insertNode('base.text', { text: 'a' }, rootId)
    getStore().updateNodeProps(nodeId, { text: 'b' })
    expect(getStore()._historyPast.length).toBeGreaterThan(0)

    // A genuinely different site (a project switch, or — the shape a
    // shifted structural edit produces — a reparse whose ids moved):
    // `makeSite()`'s own fixture ids share nothing with `nodeId`/`rootId`.
    const differentSite = makeSite()
    getStore().loadSite(differentSite)

    expect(getStore()._historyPast).toEqual([])
    expect(getStore()._historyFuture).toEqual([])
    expect(getStore().canUndo).toBe(false)
    expect(getStore().canRedo).toBe(false)
  })
})
