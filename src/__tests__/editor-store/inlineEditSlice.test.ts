/**
 * Inline text edit slice tests — session lifecycle, one-write-per-session
 * commit (one undo entry), Escape-cancel writes nothing, and start
 * guards (non-editable modules, link-with-children, non-string props).
 * Contract: docs/agent-refs/canvas-internals.md → "Inline text editing"
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { makeNode, makePage } from '../fixtures'
// Side-effect imports: register the modules under test into the global registry.
import '@modules/base/text'
import '@modules/base/button'
import '@modules/base/link'
import '@modules/base/container'

function setupSiteWithTextNode(text = 'Hello'): { nodeId: string; rootId: string; pageId: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Inline Edit Test Site')
  const pageId = site.pages[0].id
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', { text }, rootId)
  return { nodeId, rootId, pageId }
}

function nodeText(nodeId: string): unknown {
  const site = useEditorStore.getState().site!
  for (const page of site.pages) {
    if (page.nodes[nodeId]) return page.nodes[nodeId].props.text
  }
  return undefined
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hasUnsavedChanges: false,
  })
})

describe('startInlineEdit', () => {
  // `live-18` — the bridge-frame caller needs the return value to answer the
  // frame's `text:editStart` request before it can seed any DOM.
  it('returns whether a session actually started', () => {
    const { nodeId } = setupSiteWithTextNode()
    expect(useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')).toBe(true)
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState().startInlineEdit('does-not-exist', 'bp-desktop')).toBe(false)
  })

  it('opens a multiline session for base.text on the text prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toEqual({
      nodeId,
      prop: 'text',
      breakpointId: 'bp-desktop',
      // WS-10 §4.4 (Phase 4) — no board frame in this fixture, so both stay
      // `null`: the default (undo-tracked) `updateNodeProps` path, exactly
      // as before this phase existed.
      frameId: null,
      localeOverride: null,
      multiline: true,
      initialValue: 'Hello',
      draft: 'Hello',
    })
  })

  it('a text tool session can open with its placeholder selected', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop', null, { selectAll: true })
    expect(useEditorStore.getState().activeInlineEdit?.selectAll).toBe(true)
  })

  it('opens a single-line session for base.button on the label prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const buttonId = useEditorStore.getState().insertNode('base.button', { label: 'Go' }, rootId)
    useEditorStore.getState().startInlineEdit(buttonId, 'bp-mobile')
    const session = useEditorStore.getState().activeInlineEdit
    expect(session?.prop).toBe('label')
    expect(session?.multiline).toBe(false)
    expect(session?.initialValue).toBe('Go')
  })

  it('opens a session for a childless base.link on the text prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit?.prop).toBe('text')
  })

  it('no-ops for modules without inlineTextEdit', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().startInlineEdit(containerId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops for base.link with children (text renders only childless)', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().insertNode('base.text', {}, linkId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops with a [canvas] warning when the stored prop is not a string', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().updateNodeProps(nodeId, { text: 42 })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toStartWith('[canvas]')
    warn.mockRestore()
  })

  it('no-ops for unknown node ids', () => {
    setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit('does-not-exist', 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})

describe('one session = one write', () => {
  function type5(): void {
    for (const v of ['A', 'AB', 'ABC', 'ABCD', 'ABCDE']) useEditorStore.getState().applyInlineEditValue(v)
  }

  it('typing writes nothing to the tree and records no history', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    type5()
    const state = useEditorStore.getState()
    expect(nodeText(nodeId)).toBe('Hello')
    expect(state._historyPast.length).toBe(entriesBefore)
    expect(state.activeInlineEdit?.draft).toBe('ABCDE')
  })

  it('Escape after typing writes nothing and leaves the original text', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    type5()
    useEditorStore.getState().cancelInlineEdit()
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('Hello')
    expect(state._historyPast.length).toBe(entriesBefore)
  })

  it('Enter after typing writes once: ONE undo entry that restores the original', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    type5()
    useEditorStore.getState().endInlineEdit()
    expect(nodeText(nodeId)).toBe('ABCDE')
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesBefore + 1)
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('Hello')
  })

  it('Arabic text commits whole, once', () => {
    const { nodeId } = setupSiteWithTextNode('مرحبا')
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    for (const v of ['م', 'مر', 'مرح', 'مرحب', 'مرحبا بكم']) useEditorStore.getState().applyInlineEditValue(v)
    useEditorStore.getState().endInlineEdit()
    expect(nodeText(nodeId)).toBe('مرحبا بكم')
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesBefore + 1)
  })

  it('an unchanged draft commits no history entry', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().applyInlineEditValue('Hello')
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesBefore)
  })

  it('the commit does not fold into a prior Properties-panel burst on the same prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'PanelTyped' })
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('PanelTypedX')
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesBefore + 1)
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('PanelTyped')
  })

  it('apply / end / cancel no-op without an active session', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().applyInlineEditValue('ignored')
    useEditorStore.getState().endInlineEdit()
    useEditorStore.getState().cancelInlineEdit()
    expect(nodeText(nodeId)).toBe('Hello')
  })

  it('a later edit of the same prop starts a fresh undo entry after the commit', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('HelloA')
    useEditorStore.getState().endInlineEdit()
    const entries = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'HelloB' })
    expect(useEditorStore.getState()._historyPast.length).toBe(entries + 1)
  })
})

describe('force-close', () => {
  it('clears the session when the edited node is deleted', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().deleteNode(nodeId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session when the edited node is swept with a deleted ancestor', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', { text: 'Hi' }, containerId)
    useEditorStore.getState().startInlineEdit(textId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().deleteNode(containerId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on page switch', () => {
    const { nodeId, pageId } = setupSiteWithTextNode()
    // addPage activates the new page — hop back before starting the session.
    const pageB = useEditorStore.getState().addPage('Second', 'second')
    useEditorStore.getState().openPageInCanvas(pageId)
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().openPageInCanvas(pageB.id)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on active-document switch', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: 'vc-x' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})

// WS-10 §4.4 (Phase 4) — the proof the coordinator asked for at the store
// level: a session started in a board frame whose OWN `axes.locale` differs
// from the board default mutates `localizedPageSlice.ts`'s tree, NEVER
// `site.pages`/`mutateActiveTree` — which is what makes a text edit in the
// Arabic frame land in `translations.js`'s `ar` branch and not `en`'s (the
// PARSE side of that proof — that a locale variant's `textOrigin` actually
// points at the right literal — is `server/handlers/__tests__/
// localizedPage.test.ts`; this file proves the STORE routes the edit to the
// right TREE in the first place).
describe('locale-variant frame sessions (WS-10 §4.4)', () => {
  const LOCALE_KEY = 'home::ar'

  function setupLocalizedFrame(): { nodeId: string } {
    const arText = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'مرحبا' } })
    const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arText.id] })
    const arPage = makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arText.id]: arText } })

    const board = createBoard('board-1', 'Board 1')
    board.frames = [{ id: 'frame-ar', pageId: 'home', x: 0, y: 0, axes: { locale: 'ar' } }]
    const file: BoardsFile = { version: 1, boards: [board] }

    useEditorStore.setState({
      previewAxes: { direction: 'ltr', colorScheme: 'light' },
      localizedPages: { [LOCALE_KEY]: arPage },
      localizedPageStatus: { [LOCALE_KEY]: 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })

    return { nodeId: arText.id }
  }

  it('resolves the session against the localized tree, not the (nonexistent) active tree', () => {
    const { nodeId } = setupLocalizedFrame()
    useEditorStore.getState().startInlineEdit(nodeId, 'studio', 'frame-ar')
    const session = useEditorStore.getState().activeInlineEdit
    expect(session).not.toBeNull()
    expect(session?.frameId).toBe('frame-ar')
    expect(session?.localeOverride).toEqual({ pageId: 'home', locale: 'ar' })
    expect(session?.initialValue).toBe('مرحبا')
  })

  it('typing touches nothing; the commit mutates ONLY localizedPages, with no undo entry', () => {
    const { nodeId } = setupLocalizedFrame()
    useEditorStore.getState().startInlineEdit(nodeId, 'studio', 'frame-ar')
    useEditorStore.getState().applyInlineEditValue('مرحبا جدا')
    expect(useEditorStore.getState().localizedPages[LOCALE_KEY]?.nodes[nodeId]?.props.text).toBe('مرحبا')
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState().localizedPages[LOCALE_KEY]?.nodes[nodeId]?.props.text).toBe('مرحبا جدا')
    // Deliberately undo-EXEMPT: a localized preview edit is a per-frame
    // PREVIEW overlay, not the document (see localizedPageSlice.ts).
    expect(useEditorStore.getState()._historyPast.length).toBe(0)
  })

  it('cancelInlineEdit leaves the localized node untouched', () => {
    const { nodeId } = setupLocalizedFrame()
    useEditorStore.getState().startInlineEdit(nodeId, 'studio', 'frame-ar')
    useEditorStore.getState().applyInlineEditValue('مرحبا جدا')
    useEditorStore.getState().cancelInlineEdit()
    expect(useEditorStore.getState().localizedPages[LOCALE_KEY]?.nodes[nodeId]?.props.text).toBe('مرحبا')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(useEditorStore.getState()._historyPast.length).toBe(0)
  })

  it('a frame with NO locale override on the same board resolves localeOverride to null — the ordinary site path', () => {
    setupLocalizedFrame()
    // `loadBoards` publishes a frozen file (`store-09` moved it to a Mutative
    // recipe so it can also purge board history), so build the second frame
    // into a fresh board rather than mutating the loaded one in place.
    const loaded = useEditorStore.getState().boards.boards[0]!
    const board = {
      ...loaded,
      frames: [...loaded.frames, { id: 'frame-default', pageId: 'home', x: 900, y: 0 }],
    }
    useEditorStore.setState({ boards: { version: 1, boards: [board] } })

    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'studio', 'frame-default')
    const session = useEditorStore.getState().activeInlineEdit
    expect(session?.frameId).toBe('frame-default')
    expect(session?.localeOverride).toBeNull()
  })
})
