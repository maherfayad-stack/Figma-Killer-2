/**
 * `vectorEditVerdict` — the one decision both doors into vector edit mode
 * share: the double-click (which explains a refusal) and the selection
 * toolbar's "Edit points" button (which only appears where entering would
 * succeed). If the two ever disagreed, the button would open a mode the
 * double-click refuses, or hide on a graphic the double-click edits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { tryEnterVectorEdit, vectorEditVerdict } from '@site/canvas/BoardVectorLayer/vectorEditEntry'
import { exitVectorEdit, getVectorEditTarget } from '@site/canvas/BoardVectorLayer/vectorEditState'
import { makeNode, makePage, makeSite } from '../fixtures'

const HOST = 'src/Icon.tsx:3:6'
const RAW_ICON = 'src/Icon.tsx:9:6'
const LOCKED = 'src/Icon.tsx:12:6'
const TEXT = 'src/Icon.tsx:15:6'
const STAMPED = '<svg viewBox="0 0 24 24"><path data-studio-svg-part="4:8" d="M0 0L10 0L10 10"/></svg>'

beforeEach(() => {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [HOST, RAW_ICON, LOCKED, TEXT] }),
      [HOST]: makeNode({ id: HOST, moduleId: 'base.svg', props: { svg: STAMPED } }),
      [RAW_ICON]: makeNode({ id: RAW_ICON, moduleId: 'base.svg', props: { svg: STAMPED, tag: 'icons/star.svg' } }),
      [LOCKED]: makeNode({ id: LOCKED, moduleId: 'base.svg', props: { svg: STAMPED }, locked: true }),
      [TEXT]: makeNode({ id: TEXT, moduleId: 'base.text', props: { text: 'hi' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => exitVectorEdit())

describe('vectorEditVerdict', () => {
  it('a literal, stamped <svg> is editable', () => {
    expect(vectorEditVerdict(useEditorStore.getState(), HOST)).toEqual({ kind: 'editable', pageId: 'page-1' })
  })

  it('an .svg-file icon and a locked svg refuse by name; a non-svg is not the mode’s at all', () => {
    expect(vectorEditVerdict(useEditorStore.getState(), RAW_ICON).kind).toBe('refused')
    expect(vectorEditVerdict(useEditorStore.getState(), LOCKED).kind).toBe('refused')
    expect(vectorEditVerdict(useEditorStore.getState(), TEXT).kind).toBe('not-svg')
  })

  it('tryEnterVectorEdit enters exactly where the verdict says editable', () => {
    expect(tryEnterVectorEdit(TEXT, 'f1')).toBe(false)
    expect(getVectorEditTarget()).toBeNull()
    expect(tryEnterVectorEdit(RAW_ICON, 'f1')).toBe(true)
    expect(getVectorEditTarget()).toBeNull()
    expect(tryEnterVectorEdit(HOST, 'f1')).toBe(true)
    expect(getVectorEditTarget()).toEqual({ hostNodeId: HOST, pageId: 'page-1', frameId: 'f1' })
  })
})
