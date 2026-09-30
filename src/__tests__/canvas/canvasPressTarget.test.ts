/**
 * canvasPressTarget — WHICH layer a press means (Figma's selection depth).
 *
 * The owner's report: "when I click and drag [a container], it selects
 * children before going to the next step". The browser hands the canvas the
 * innermost element, and the canvas used to take it at its word, so a press
 * on a card's title selected — and dragged — the title. These cases pin the
 * depth rule every press path now shares (click, hover, double-click, and
 * both body-drag triggers), as pure functions over a tree.
 */
import { describe, expect, it } from 'bun:test'
import {
  clampToComponentBoundary,
  planCanvasPressDrag,
  resolveCanvasDrillTarget,
  resolveCanvasPressTarget,
  type CanvasPressContext,
} from '@site/canvas/canvasPressTarget'
import { makeNode, makePage } from '../fixtures'

/**
 * body → screen (the page component's own root)
 *          → card → [title, cta → [ctaLabel]]
 *          → footer → [link]
 *          → widget (a closed studio.instance) → [widgetInner]
 */
function screenPage() {
  return makePage({
    id: 'p',
    rootNodeId: 'body',
    nodes: {
      body: makeNode({ id: 'body', moduleId: 'base.body', children: ['screen'] }),
      screen: makeNode({ id: 'screen', moduleId: 'base.div', children: ['card', 'footer', 'widget'] }),
      card: makeNode({ id: 'card', moduleId: 'base.div', children: ['title', 'cta'] }),
      title: makeNode({ id: 'title', moduleId: 'base.text' }),
      cta: makeNode({ id: 'cta', moduleId: 'base.button', children: ['ctaLabel'] }),
      ctaLabel: makeNode({ id: 'ctaLabel', moduleId: 'base.text' }),
      footer: makeNode({ id: 'footer', moduleId: 'base.div', children: ['link'] }),
      link: makeNode({ id: 'link', moduleId: 'base.text' }),
      widget: makeNode({ id: 'widget', moduleId: 'studio.instance', children: ['widgetInner'] }),
      widgetInner: makeNode({ id: 'widgetInner', moduleId: 'base.text' }),
    },
  })
}

function context(selectedIds: string[] = [], enteredInstanceIds: string[] = []): CanvasPressContext {
  return { selectedIds, enteredInstanceIds, vcLockdown: true }
}

const page = screenPage()
const shallow = { deep: false }

describe('resolveCanvasPressTarget — nothing selected', () => {
  it('a press on a nested element means the top-level layer it sits in, not the innermost', () => {
    expect(resolveCanvasPressTarget(page, 'ctaLabel', context(), shallow)).toBe('card')
    expect(resolveCanvasPressTarget(page, 'title', context(), shallow)).toBe('card')
    expect(resolveCanvasPressTarget(page, 'link', context(), shallow)).toBe('footer')
  })

  it('treats the page root AND its only child (the screen) as the frame, so presses reach through them', () => {
    // A press on the screen's own background still selects the screen …
    expect(resolveCanvasPressTarget(page, 'screen', context(), shallow)).toBe('screen')
    // … and on the body, the body.
    expect(resolveCanvasPressTarget(page, 'body', context(), shallow)).toBe('body')
  })

  it('⌘/Ctrl (deep) goes straight to the innermost layer', () => {
    expect(resolveCanvasPressTarget(page, 'ctaLabel', context(), { deep: true })).toBe('ctaLabel')
  })
})

describe('resolveCanvasPressTarget — with a selection', () => {
  it('a press INSIDE the selected layer means that layer (the container the user already picked)', () => {
    expect(resolveCanvasPressTarget(page, 'ctaLabel', context(['card']), shallow)).toBe('card')
    expect(resolveCanvasPressTarget(page, 'title', context(['card']), shallow)).toBe('card')
  })

  it('a press on a sibling of the selected layer selects at the SAME depth', () => {
    // `title` is selected (depth 3); `ctaLabel` sits inside its sibling `cta`.
    expect(resolveCanvasPressTarget(page, 'ctaLabel', context(['title']), shallow)).toBe('cta')
  })

  it('a press outside the selected layer’s parent climbs back to where the two paths meet', () => {
    expect(resolveCanvasPressTarget(page, 'link', context(['title']), shallow)).toBe('footer')
  })

  it('a selected frame level (screen or body) stays transparent', () => {
    expect(resolveCanvasPressTarget(page, 'title', context(['screen']), shallow)).toBe('card')
    expect(resolveCanvasPressTarget(page, 'title', context(['body']), shallow)).toBe('card')
  })
})

describe('resolveCanvasPressTarget — components are one layer until entered', () => {
  it('clamps a press inside a closed instance to the instance', () => {
    expect(clampToComponentBoundary(page, 'widgetInner', context())).toBe('widget')
    expect(resolveCanvasPressTarget(page, 'widgetInner', context(), { deep: true })).toBe('widget')
  })

  it('an entered instance lets presses through to its children', () => {
    expect(resolveCanvasPressTarget(page, 'widgetInner', context(['widget'], ['widget']), shallow)).toBe('widget')
    expect(resolveCanvasPressTarget(page, 'widgetInner', context([], ['widget']), { deep: true })).toBe('widgetInner')
  })
})

describe('resolveCanvasDrillTarget — a double-click steps ONE container level down', () => {
  it('from the container the clicks selected, to its child on the way to the pressed element', () => {
    // The two clicks of the double-click left `screen`'s child `card`
    // selected… the pointer is on `cta`'s own box (a container), so the
    // double-click opens `card` one level.
    expect(resolveCanvasDrillTarget(page, 'cta', context(['card']))).toEqual({ select: 'cta', thenEdit: false })
    // Nothing selected: the clicks selected `footer`; the pressed `footer`
    // has children, and is what the clicks already reached — nothing to open.
    expect(resolveCanvasDrillTarget(page, 'footer', context(['footer']))).toBeNull()
  })

  it('a double-click on a LEAF (text) selects it and goes on to edit it, however deep it sits', () => {
    expect(resolveCanvasDrillTarget(page, 'title', context(['card']))).toEqual({ select: 'title', thenEdit: true })
    expect(resolveCanvasDrillTarget(page, 'ctaLabel', context(['cta']))).toEqual({ select: 'ctaLabel', thenEdit: true })
  })

  it('is null once the innermost layer is reached — the double-click then edits text / opens an instance', () => {
    expect(resolveCanvasDrillTarget(page, 'ctaLabel', context(['ctaLabel']))).toBeNull()
    expect(resolveCanvasDrillTarget(page, 'widgetInner', context(['widget']))).toBeNull()
  })
})

describe('planCanvasPressDrag — what a body drag carries', () => {
  it('drags the top-level layer and selects it only once the drag activates', () => {
    expect(planCanvasPressDrag(page, 'ctaLabel', context(), shallow)).toEqual({
      candidateIds: ['card'],
      preferredDraggedId: 'card',
      selectOnActivate: 'card',
    })
  })

  it('pressing inside the selected container drags the CONTAINER, never the child under the pointer', () => {
    expect(planCanvasPressDrag(page, 'ctaLabel', context(['card']), shallow)).toEqual({
      candidateIds: ['card'],
      preferredDraggedId: 'card',
      selectOnActivate: null,
    })
  })

  it('pressing inside a multi-selection drags the whole selection', () => {
    expect(planCanvasPressDrag(page, 'link', context(['card', 'footer']), shallow)).toEqual({
      candidateIds: ['card', 'footer'],
      preferredDraggedId: 'footer',
      selectOnActivate: null,
    })
  })

  it('⌘ held drags the innermost layer', () => {
    expect(planCanvasPressDrag(page, 'ctaLabel', context(['card']), { deep: true }).preferredDraggedId).toBe('ctaLabel')
  })
})
