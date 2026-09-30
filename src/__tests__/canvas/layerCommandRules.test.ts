/**
 * P5-E — the pure halves of align (IX-20), ⇧A (IX-10) and copy / paste style
 * (IX-props). The keys that run them are `layerCommandKeys.test.tsx`.
 */
import { describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { planAlign, type AlignLayer } from '@site/canvas/layerAlign'
import { flexLayoutPatch, inferFlexDirection, pasteStylePatch, styleOf } from '@site/canvas/layerCommands'
import type { ArrowParentLayout, ArrowTargetStyle } from '@site/canvas/canvasNodeArrowMove'

const FLOW: ArrowTargetStyle = { position: 'static', direction: 'ltr', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' }
const ROW: ArrowParentLayout = { display: 'flex', flexDirection: 'row', gridAutoFlow: 'row', direction: 'ltr', gridColumns: 1, gridRows: 1 }

function tree(nodes: Record<string, Partial<PageNode>>): NodeTree<PageNode> {
  const built: Record<string, PageNode> = {}
  for (const [id, node] of Object.entries(nodes)) {
    built[id] = { id, moduleId: 'base.container', props: {}, children: [], classIds: [], parentId: null, breakpointOverrides: {}, ...node } as PageNode
  }
  return { rootNodeId: 'root', nodes: built } as NodeTree<PageNode>
}

function layer(overrides: Partial<AlignLayer>): AlignLayer {
  return { nodeId: 'x', own: FLOW, rect: null, layout: ROW, parentId: 'row', siblingCount: 3, ...overrides }
}

describe('planAlign (IX-20)', () => {
  const t = tree({ root: {}, row: {}, a: {}, only: {} })

  it('a flow child on the CROSS axis aligns itself (align-self) through the inspector', () => {
    expect(planAlign('top', [layer({ nodeId: 'a' })], t, undefined)).toEqual({
      kind: 'self',
      nodeId: 'a',
      property: 'alignSelf',
      value: 'flex-start',
    })
  })

  it('on the MAIN axis with siblings there is no single honest write — it says why', () => {
    const plan = planAlign('left', [layer({ nodeId: 'a' })], t, undefined)
    expect(plan.kind).toBe('refused')
  })

  it('an only child on the main axis writes its PARENT’s justify-content', () => {
    expect(planAlign('right', [layer({ nodeId: 'only', siblingCount: 1 })], t, undefined)).toEqual({
      kind: 'parent',
      parentId: 'row',
      property: 'justifyContent',
      value: 'flex-end',
    })
  })

  it('an inline-flex parent aligns like a flex one', () => {
    const plan = planAlign('top', [layer({ nodeId: 'a', layout: { ...ROW, display: 'inline-flex' } })], t, undefined)
    expect(plan.kind).toBe('self')
  })

  it('a mixed selection: positioned layers move, flow children take align-self, ONE patch list', () => {
    const t2 = tree({ root: {}, row: {}, a: {}, p: { inlineStyles: { position: 'absolute', left: '30px' } } })
    const plan = planAlign(
      'middle',
      [
        layer({ nodeId: 'a' }),
        layer({ nodeId: 'p', own: { ...FLOW, position: 'absolute', left: '30px', right: '70px', top: '10px', bottom: '50px' } }),
      ],
      t2,
      undefined,
    )
    expect(plan).toEqual({
      kind: 'patches',
      patches: [
        { nodeId: 'a', patch: { alignSelf: 'center' } },
        // Alone among the positioned: to its containing block, (50 − 10) / 2 = 20 down.
        { nodeId: 'p', patch: { top: '30px' } },
      ],
    })
  })
})

describe('⇧A (IX-10)', () => {
  it('reads the direction the children already run', () => {
    expect(inferFlexDirection([{ x: 0, y: 0, width: 50, height: 20 }, { x: 60, y: 0, width: 50, height: 20 }])).toBe('row')
    expect(inferFlexDirection([{ x: 0, y: 0, width: 50, height: 20 }, { x: 0, y: 25, width: 50, height: 20 }])).toBe('column')
    // One child keeps a block's vertical stacking.
    expect(inferFlexDirection([{ x: 0, y: 0, width: 50, height: 20 }])).toBe('column')
  })

  it('adds flex in that direction; on a flex container it takes flex away (Penpot’s toggle)', () => {
    expect(flexLayoutPatch('block', 'row')).toEqual({ display: 'flex', flexDirection: 'row' })
    expect(flexLayoutPatch('inline-flex', 'row')).toEqual({ display: null, flexDirection: null })
  })
})

describe('copy / paste style (IX-props)', () => {
  it('style is everything but position and size', () => {
    expect(styleOf({ color: 'red', width: '10px', left: '4px', position: 'absolute', padding: 8, gridArea: 'a' })).toEqual({
      color: 'red',
      padding: 8,
    })
  })

  it('pasting REPLACES the target’s style: copied keys set, its other style keys cleared, geometry untouched', () => {
    const copied = { inlineStyles: { color: 'red' }, classIds: [] }
    expect(pasteStylePatch(copied, { background: 'blue', width: '40px' })).toEqual({ color: 'red', background: null })
  })
})
