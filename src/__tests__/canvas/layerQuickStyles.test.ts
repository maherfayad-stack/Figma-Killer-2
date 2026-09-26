/**
 * P5-F (IX-misc) — the one-key style commands: opacity on the digits, flip on
 * ⇧H / ⇧V. The key predicates are the registry's; the writes go through the
 * store's batch actions, one call for the whole selection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { opacityDigit } from '@admin/spotlight/keybindingLayerCommands'
import { useEditorStore } from '@site/store/store'
import { flipPatchFor, flipSelection, opacityForDigit, setSelectionOpacity } from '@site/canvas/layerQuickStyles'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function key(init: Partial<{ key: string; code: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }>) {
  return { key: '', code: '', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...init }
}

describe('the keys', () => {
  it('a bare digit is an opacity key, by key or by physical code', () => {
    expect(opacityDigit(key({ key: '5' }))).toBe(5)
    expect(opacityDigit(key({ key: '&', code: 'Digit1' }))).toBe(1)
    expect(opacityDigit(key({ key: '0', code: 'Numpad0' }))).toBe(0)
    expect(opacityDigit(key({ key: 'a' }))).toBeNull()
  })

  it('Shift+digit stays the zoom keys, and never an opacity', () => {
    expect(opacityDigit(key({ key: '!', code: 'Digit1', shiftKey: true }))).toBeNull()
    expect(getKeybindingForCommand('canvas.zoomToFit')?.match(key({ key: '!', code: 'Digit1', shiftKey: true }))).toBe(true)
  })

  it('Shift+H and Shift+V flip; bare H is still the hand tool', () => {
    expect(getKeybindingForCommand('layers.flipHorizontal')?.match(key({ key: 'H', code: 'KeyH', shiftKey: true }))).toBe(true)
    expect(getKeybindingForCommand('layers.flipVertical')?.match(key({ key: 'V', code: 'KeyV', shiftKey: true }))).toBe(true)
    expect(getKeybindingForCommand('layers.flipHorizontal')?.match(key({ key: 'h', code: 'KeyH' }))).toBe(false)
  })
})

describe('the values', () => {
  it('1–9 are tenths; 0 clears the layer’s own opacity', () => {
    expect(opacityForDigit(5)).toBe('0.5')
    expect(opacityForDigit(1)).toBe('0.1')
    expect(opacityForDigit(0)).toBeNull()
  })

  it('a flip toggles one axis of the standalone scale', () => {
    expect(flipPatchFor(undefined, 'x')).toEqual({ scale: '-1 1' })
    expect(flipPatchFor({ scale: '-1 1' }, 'x')).toEqual({ scale: null })
    expect(flipPatchFor({ scale: '2' }, 'y')).toEqual({ scale: '2 -2' })
  })

  it('refuses a transform that already scales, and a scale it cannot toggle', () => {
    expect(flipPatchFor({ transform: 'scaleX(-1)' }, 'x')).toHaveProperty('refused')
    expect(flipPatchFor({ scale: '50%' }, 'x')).toHaveProperty('refused')
  })
})

describe('the writes — one call for the whole selection', () => {
  let batch: Array<{ ids: string[]; patch: Record<string, unknown> }>
  let perNode: Array<ReadonlyArray<{ nodeId: string; patch: Record<string, unknown> }>>

  beforeEach(() => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'home',
            slug: 'index',
            rootNodeId: 'root',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.container', children: ['a', 'b'] }),
              a: makeNode({ id: 'a', moduleId: 'base.container', parentId: 'root', inlineStyles: { opacity: '0.3' } }),
              b: makeNode({ id: 'b', moduleId: 'base.container', parentId: 'root', inlineStyles: { scale: '-1 1' } }),
            },
          }),
        ],
      }),
    )
    batch = []
    perNode = []
    useEditorStore.setState({
      activePageId: 'home',
      selectedNodeIds: ['a', 'b'],
      selectedNodeId: 'b',
      setNodesInlineStyles: (ids: string[], patch: Record<string, unknown>) => void batch.push({ ids, patch }),
      setNodesInlineStylesPerNode: (patches: ReadonlyArray<{ nodeId: string; patch: Record<string, unknown> }>) => void perNode.push(patches),
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  afterEach(() => {
    useEditorStore.setState({ site: null, selectedNodeIds: [], selectedNodeId: null } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('5 sets 50 % on every selected layer', () => {
    setSelectionOpacity(5)
    expect(batch).toEqual([{ ids: ['a', 'b'], patch: { opacity: '0.5' } }])
  })

  it('0 clears only the layers that have their own opacity', () => {
    setSelectionOpacity(0)
    expect(batch).toEqual([{ ids: ['a'], patch: { opacity: null } }])
  })

  it('Shift+H flips each layer from where it is', () => {
    flipSelection('x')
    expect(perNode).toEqual([[
      { nodeId: 'a', patch: { scale: '-1 1' } },
      { nodeId: 'b', patch: { scale: null } },
    ]])
  })
})
