/**
 * dropAxisRules — CSS → drop-insertion-axis mapping (G9), moved out of the
 * admin-only `canvasDomGeometry.ts` (`speed-06`) so the in-frame Tier 2
 * candidate builder (`dropCandidates.ts`) can compute the SAME axis a portal
 * frame's own scan does, instead of growing a second copy. One implementation,
 * two callers — the same shape `hoverSuppressionRules.ts`/`elementResizeRules.ts`
 * already follow for the portal-injector / in-frame-runtime split.
 *
 * Pure DOM: reads only `element.parentElement` and `getComputedStyle` off
 * whichever `Document`/`Window` the element's own `ownerDocument` names, so
 * it is correct in BOTH the parent editor's realm (a portal frame's DOM) and
 * a live frame's own realm (this module, imported into the runtime bundle) —
 * no admin import, no runtime-only import, safe on both sides of the bridge.
 *
 * `canvasDomGeometry.ts` re-exports `resolveCanvasAxisFromStyle`/
 * `resolveCanvasInsertionAxis` from here verbatim so existing admin-side
 * imports (`canvasDnd.ts`'s doc comment, `canvasInsertionAxis.test.ts`) are
 * unchanged.
 */

export type CanvasDropAxis = 'vertical' | 'horizontal'

/** The subset of `CSSStyleDeclaration` `resolveCanvasAxisFromStyle` reads — a structural type so it can be unit-tested with a plain object, no DOM. */
export interface CanvasAxisStyleInput {
  display: string
  flexDirection: string
  gridAutoFlow: string
  direction: string
}

export interface CanvasAxisResolution {
  axis: CanvasDropAxis
  /** True when the parent lays its children out in the REVERSE of DOM child order along `axis` — see `resolveCanvasAxisFromStyle`'s own body for the RTL/`*-reverse` cases this covers. */
  reversed: boolean
}

/**
 * G9 — pure CSS→axis mapping, extracted so grid/`*-reverse`/RTL logic is
 * directly unit-testable without a real browser layout. Only reads FOUR
 * computed-style properties; `resolveCanvasInsertionAxis` below is the DOM
 * wrapper that finds the layout parent and reads them off it.
 *
 * **Grid is a CSS-only heuristic, not the sibling-geometry-derived axis the
 * fully correct fix would compute** (compare row/column overlap of actual
 * sibling rects — see `STUDIO-FIGMA-PARITY-PLAN.md`'s G9 finding). That needs
 * the candidate builder to thread sibling rects into this function, which is
 * a larger plumbing change deferred out of this pass. What ships here:
 * `gridAutoFlow: column` (dense-column placement, fills a column top-to-bottom
 * before wrapping) resolves `vertical`; the default row autoflow (fills a row
 * left-to-right before wrapping) resolves `horizontal`. Strictly better than
 * the PRE-G9 behavior (`'vertical'` unconditionally, which drew horizontal
 * insertion bars across a side-by-side card gallery) but still wrong for any
 * grid whose visual flow doesn't match its `gridAutoFlow` keyword alone —
 * e.g. an explicit `grid-template-columns` layout with items NOT auto-placed.
 */
export function resolveCanvasAxisFromStyle(style: CanvasAxisStyleInput): CanvasAxisResolution {
  const rtl = style.direction === 'rtl'

  if (style.display.includes('grid')) {
    const columnFlow = style.gridAutoFlow.includes('column')
    return columnFlow ? { axis: 'vertical', reversed: false } : { axis: 'horizontal', reversed: rtl }
  }

  if (style.display.includes('flex')) {
    const isRow = style.flexDirection.startsWith('row')
    const isReverseFlexDirection = style.flexDirection.endsWith('reverse')
    if (isRow) {
      // Visual-left is the logical END of the axis under `direction: rtl`;
      // `row-reverse` flips visual order again. Two flips cancel out — XOR,
      // not OR — a `row-reverse` container that is ALSO `rtl` renders in DOM
      // order again (not reversed).
      return { axis: 'horizontal', reversed: isReverseFlexDirection !== rtl }
    }
    // `column` / `column-reverse` — RTL only mirrors the INLINE axis, never
    // the BLOCK axis, so `direction` plays no part here.
    return { axis: 'vertical', reversed: isReverseFlexDirection }
  }

  // Ordinary block flow (including `flex-wrap` and anything else): vertical,
  // top-to-bottom, unaffected by `direction`.
  return { axis: 'vertical', reversed: false }
}

/**
 * DOM wrapper around `resolveCanvasAxisFromStyle`: finds `target`'s nearest
 * boxed layout parent (skipping `display: contents` hosts, same as the
 * geometry walk `nodeVisualRect` does) and reads its computed style.
 *
 * Uses `target`'s OWN document's `defaultView` — not the ambient `window` —
 * because a caller in the admin realm may be reading an element that lives
 * inside a breakpoint iframe's document, a DIFFERENT realm from the parent
 * editor window; a caller inside the runtime bundle has only its own realm to
 * begin with. Real browsers resolve `window.getComputedStyle(elementFromAnotherDocument)`
 * correctly for a same-origin iframe today, but that is not a contract this
 * function should lean on (`STUDIO-FIGMA-PARITY-PLAN.md`'s G9 finding) —
 * reading from the element's own realm is correct by construction instead of
 * by browser behavior nobody promised.
 */
export function resolveCanvasInsertionAxis(target: HTMLElement): CanvasAxisResolution {
  const parent = findLayoutParent(target)
  if (!parent) return { axis: 'vertical', reversed: false }

  const view = parent.ownerDocument?.defaultView
  if (!view || typeof view.getComputedStyle !== 'function') return { axis: 'vertical', reversed: false }

  const style = view.getComputedStyle(parent)
  return resolveCanvasAxisFromStyle({
    display: style.display,
    flexDirection: style.flexDirection,
    gridAutoFlow: style.gridAutoFlow,
    direction: style.direction,
  })
}

function findLayoutParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    // Same realm-correctness note as `resolveCanvasInsertionAxis`: read from
    // the candidate parent's OWN document view, not the ambient `window`.
    const view = parent.ownerDocument?.defaultView
    const style = view && typeof view.getComputedStyle === 'function'
      ? view.getComputedStyle(parent)
      : null
    if (style?.display !== 'contents') return parent
    parent = parent.parentElement
  }
  return null
}
