/**
 * PA-7 / PA-8 — what Add auto layout and Remove auto layout (keep positions)
 * write, from measured boxes. The claim under every case: nothing moves.
 */
import { describe, expect, it } from 'bun:test'
import { planAddAutoLayout, planFreezePositions, planWrapAutoLayout, type MeasuredBox } from '@site/canvas/layoutConversionPatches'

const zero = { top: 0, right: 0, bottom: 0, left: 0 }

function box(nodeId: string, x: number, y: number, width: number, height: number, extra: Partial<MeasuredBox> = {}): MeasuredBox {
  return {
    nodeId,
    rect: { x, y, width, height },
    position: 'static',
    display: 'block',
    boxSizing: 'border-box',
    margin: zero,
    padding: zero,
    border: zero,
    inline: {},
    ...extra,
  }
}

const absolute = (
  nodeId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  inline: Record<string, unknown> = { position: 'absolute', left: `${x}px`, top: `${y}px` },
) => box(nodeId, x, y, width, height, { position: 'absolute', inline })

describe('planAddAutoLayout', () => {
  it('a free frame becomes a row: flex, gap, padding, alignment, children back in flow', () => {
    const parent = box('p', 0, 0, 400, 200, { position: 'relative', boxSizing: 'content-box' })
    const plan = planAddAutoLayout(parent, [absolute('a', 16, 16, 80, 40), absolute('b', 112, 16, 80, 40)])
    expect(plan.parentPatch).toMatchObject({
      display: 'flex',
      flexDirection: 'row',
      flexWrap: null,
      alignItems: 'flex-start',
      gap: '16px',
      paddingTop: '16px',
      paddingLeft: '16px',
      // A bare content-box container keeps its outer size once it gains padding.
      boxSizing: 'border-box',
    })
    expect(plan.childPatches).toEqual([
      { nodeId: 'a', patch: { position: null, left: null, top: null } },
      { nodeId: 'b', patch: { position: null, left: null, top: null } },
    ])
    expect(plan.order).toBeUndefined()
    expect(plan.exact).toBe(true)
  })

  it('absolute children are reordered into visual order', () => {
    const plan = planAddAutoLayout(box('p', 0, 0, 400, 100, { position: 'relative' }), [
      absolute('right', 200, 0, 50, 20),
      absolute('left', 0, 0, 50, 20),
      absolute('mid', 100, 0, 50, 20),
    ])
    expect(plan.order).toEqual(['left', 'mid', 'right'])
  })

  it('a position a class sets is overridden with static, not left in force', () => {
    const plan = planAddAutoLayout(box('p', 0, 0, 100, 100, { position: 'relative' }), [
      absolute('a', 0, 0, 40, 40, {}),
      absolute('b', 50, 0, 40, 40, {}),
    ])
    expect(plan.childPatches[0]!.patch.position).toBe('static')
  })

  it('a flow container only gains flex: its padding already is what the children show', () => {
    const parent = box('p', 0, 0, 400, 120, { padding: { top: 12, right: 12, bottom: 12, left: 12 }, boxSizing: 'content-box' })
    const plan = planAddAutoLayout(parent, [box('a', 12, 12, 376, 30), box('b', 12, 52, 376, 30)])
    expect(plan.parentPatch).toMatchObject({ display: 'flex', flexDirection: 'column', gap: '10px' })
    expect(Object.keys(plan.parentPatch)).not.toContain('paddingTop')
    expect(Object.keys(plan.parentPatch)).not.toContain('boxSizing')
    expect(plan.childPatches).toEqual([])
  })

  it('an absolute badge on a flow container stays pinned and stays out of the inference', () => {
    const plan = planAddAutoLayout(box('p', 0, 0, 300, 100, { position: 'relative' }), [
      box('a', 0, 0, 100, 40),
      box('b', 110, 0, 100, 40),
      absolute('badge', 250, 4, 20, 20),
    ])
    expect(plan.parentPatch.flexDirection).toBe('row')
    expect(plan.childPatches).toEqual([])
  })

  it('a container border is not padding', () => {
    const parent = box('p', 0, 0, 200, 100, { border: { top: 2, right: 2, bottom: 2, left: 2 }, position: 'relative' })
    const plan = planAddAutoLayout(parent, [absolute('a', 12, 12, 50, 20), absolute('b', 72, 12, 50, 20)])
    expect(plan.parentPatch.paddingLeft).toBe('10px')
    expect(plan.parentPatch.boxSizing).toBeUndefined()
  })

  it('inline padding shorthand is replaced by the four sides, never doubled', () => {
    const parent = box('p', 0, 0, 200, 100, { position: 'relative', inline: { padding: '0px' } })
    const plan = planAddAutoLayout(parent, [absolute('a', 8, 8, 50, 20), absolute('b', 70, 8, 50, 20)])
    expect(plan.parentPatch).toMatchObject({ padding: null, paddingTop: '8px', paddingRight: '8px', paddingBottom: '8px', paddingLeft: '8px' })
  })

  it('wrapped lines write both gaps and pin the line packing', () => {
    const plan = planAddAutoLayout(box('p', 0, 0, 220, 200, { position: 'relative' }), [
      absolute('a', 0, 0, 100, 50),
      absolute('b', 110, 0, 100, 50),
      absolute('c', 0, 62, 100, 50),
    ])
    expect(plan.parentPatch).toMatchObject({ flexWrap: 'wrap', alignContent: 'flex-start', gap: '12px 10px' })
  })

  it('reports an uneven layout as inexact', () => {
    const plan = planAddAutoLayout(box('p', 0, 0, 400, 100, { position: 'relative' }), [
      absolute('a', 0, 0, 50, 20),
      absolute('b', 60, 0, 50, 20),
      absolute('c', 200, 0, 50, 20),
    ])
    expect(plan.exact).toBe(false)
  })
})

describe('planFreezePositions', () => {
  const row = (parent: Partial<MeasuredBox> = {}) =>
    planFreezePositions(box('p', 100, 50, 400, 120, { display: 'flex', ...parent }), [
      box('a', 120, 70, 80, 40),
      box('b', 216, 70, 80, 40),
    ])

  it('pins every child at its offset from the container, with its size', () => {
    const plan = row()
    expect(plan.childPatches).toEqual([
      { nodeId: 'a', patch: { position: 'absolute', left: '20px', top: '20px', right: null, bottom: null, insetInlineStart: null, width: '80px', height: '40px' } },
      { nodeId: 'b', patch: { position: 'absolute', left: '116px', top: '20px', right: null, bottom: null, insetInlineStart: null, width: '80px', height: '40px' } },
    ])
  })

  it('the container leaves flex, becomes the containing block and keeps its height', () => {
    expect(row().parentPatch).toMatchObject({
      display: 'block',
      position: 'relative',
      height: '120px',
      flexDirection: null,
      gap: null,
      alignItems: null,
    })
  })

  it('offsets come from the padding box: the border and the child margin come off', () => {
    const plan = planFreezePositions(box('p', 0, 0, 200, 100, { display: 'flex', border: { top: 4, right: 4, bottom: 4, left: 4 } }), [
      box('a', 24, 14, 50, 30, { margin: { top: 6, right: 0, bottom: 0, left: 8 } }),
    ])
    expect(plan.childPatches[0]!.patch).toMatchObject({ left: '12px', top: '4px' })
  })

  it('a content-box child is sized by its content box', () => {
    const plan = planFreezePositions(box('p', 0, 0, 200, 100, { display: 'flex' }), [
      box('a', 0, 0, 60, 40, {
        boxSizing: 'content-box',
        padding: { top: 5, right: 5, bottom: 5, left: 5 },
        border: { top: 1, right: 1, bottom: 1, left: 1 },
      }),
    ])
    expect(plan.childPatches[0]!.patch).toMatchObject({ width: '48px', height: '28px' })
  })

  it('an inline display is cleared; one a class sets is overridden', () => {
    expect(row({ inline: { display: 'flex' } }).parentPatch.display).toBeNull()
    expect(row().parentPatch.display).toBe('block')
  })

  it('leaves a container that is positioned already, and one with an authored height, alone', () => {
    const plan = row({ position: 'relative', inline: { height: '120px', display: 'flex' } })
    expect(plan.parentPatch.position).toBeUndefined()
    expect(plan.parentPatch.height).toBeUndefined()
  })

  it('leaves absolute children and children without a box alone', () => {
    const plan = planFreezePositions(box('p', 0, 0, 200, 100, { display: 'flex', position: 'relative' }), [
      box('a', 0, 0, 50, 20),
      absolute('badge', 150, 0, 20, 20),
      box('hidden', 0, 0, 0, 0, { display: 'none' }),
    ])
    expect(plan.childPatches.map((entry) => entry.nodeId)).toEqual(['a'])
  })

  it('an inline-flex container keeps its width', () => {
    const plan = row({ display: 'inline-flex' })
    expect(plan.parentPatch.width).toBe('400px')
  })
})

describe('planAddAutoLayout — margins', () => {
  it('margins between flow children are not counted twice: the gap is what is left between the margin boxes', () => {
    const margin = { top: 0, right: 0, bottom: 10, left: 0 }
    const plan = planAddAutoLayout(box('p', 0, 0, 200, 200), [
      box('a', 0, 0, 200, 30, { margin }),
      box('b', 0, 40, 200, 30, { margin }),
    ])
    expect(plan.parentPatch).toMatchObject({ flexDirection: 'column', gap: '0px', alignItems: 'stretch' })
  })
})

describe('planWrapAutoLayout', () => {
  it('reads the gap between stacked layers', () => {
    const style = planWrapAutoLayout([box('a', 0, 0, 120, 40), box('b', 0, 64, 180, 40)])
    expect(style).toEqual({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '24px' })
  })

  it('reads a row, and writes no gap when the layers touch', () => {
    const style = planWrapAutoLayout([box('a', 0, 0, 100, 40), box('b', 100, 0, 100, 40)])
    expect(style).toMatchObject({ flexDirection: 'row' })
    expect(style).not.toHaveProperty('gap')
  })

  it('spacing a margin makes is not lost: the gap is what is left between the margin boxes', () => {
    const margin = { top: 0, right: 0, bottom: 10, left: 0 }
    const style = planWrapAutoLayout([box('a', 0, 0, 100, 30, { margin }), box('b', 0, 50, 100, 30, { margin })])
    // 10px margin plus 10px of real spacing: the margin stays on the layer, the gap carries the rest.
    expect(style.gap).toBe('10px')
  })
})

describe('planFreezePositions — whole pixels', () => {
  const freeze = (child: MeasuredBox) =>
    planFreezePositions(box('p', 0, 0, 400, 100, { display: 'flex' }), [child]).childPatches[0]!.patch

  it('rounds a sub-pixel size to whole pixels', () => {
    expect(freeze(box('a', 0, 0, 222.76, 47.95))).toMatchObject({ width: '223px', height: '48px' })
  })

  it('keeps a size the source authors fractionally', () => {
    const patch = freeze(box('a', 0, 0, 12.5, 40, { inline: { width: '12.5px' } }))
    expect(patch).toMatchObject({ width: '12.5px', height: '40px' })
  })
})
