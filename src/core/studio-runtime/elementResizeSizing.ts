/**
 * elementResizeSizing — what a canvas resize writes BESIDES the size, so the
 * size it writes is the size the element renders at (IX-6b).
 *
 * `width` on the main axis of a flex item that grows (`flex: 1`, a
 * `flex-grow` from a class) or has a basis is a dead write: flexbox decides
 * that size, so the handles track the cursor for the whole drag and the
 * element snaps back on release — exactly the failure `resizeOffer.ts` exists
 * to prevent. Figma answers this by flipping the item's sizing to Fixed, and
 * so does this module: every axis a drag writes goes through the inspector's
 * own Fixed switch, `sizingPatch('fixed', …)` in `elementSizingRules.ts`. That
 * is one resolver for "make this axis Fixed" whether the user clicked the W
 * field's mode menu or dragged an edge — the companion writes (dropping a
 * Fill marker, `align-self: stretch`, overriding a cascade `flex`) cannot
 * drift between the two.
 *
 * ## Two hosts, one plan
 *
 * Both resize hosts plan through here: the portal drag
 * (`useElementResizeDrag.ts`, same document) and the live frame's own handles
 * (`resizeHandles.ts`, inside the cross-origin frame). The plan needs three
 * facts — the node's STORED inline markers, the parent's computed layout and
 * the element's cascade — and only the stored markers live on the parent's
 * side of a live frame's wire. So the parent sends those markers with
 * `setResizeTarget` (`resizeMessages.ts`) and the frame plans for itself;
 * without them a live frame's flex item snapped back on release (canvas-23).
 *
 * The one thing the canvas knows that the panel does not is the element's
 * CASCADE: a `flex: 1` in a class survives clearing every inline marker. The
 * drag reads it once, at pointerdown (`probeFlexCascade`), and hands it to the
 * resolver.
 *
 * ## Double-click a handle: Hug (P5-F, IX-6f)
 *
 * Figma's gesture: double-clicking an edge handle sets that axis to Hug
 * contents, a corner both axes. {@link hugPatchForHandle} is that write, and
 * it is the inspector's own `sizingPatch('hug', …)` for each axis, against
 * the same parent layout the drag reads — so the canvas and the W/H mode
 * menu can never write different CSS for "Hug".
 *
 * ## Previewing a clear
 *
 * The portal previews on the element's own `style` and can simply remove a
 * cleared property (`elementResizeInlinePreview.ts`). A live frame previews
 * through a runtime-owned stylesheet (`resizeHandles.ts`' module doc says
 * why), and a stylesheet can SET a property but never remove an inline
 * declaration. {@link readClearedValues} answers what each cleared property
 * renders at once the inline declaration is gone, so the stylesheet can say
 * exactly that.
 */
import {
  sizingAxisRole,
  sizingPatch,
  type SizingAxis,
  type SizingFlexCascade,
  type SizingParentLayout,
  type SizingPatch,
} from './elementSizingRules'
import { resizeAxes, resizeStylePatch, type ResizeBoxStart, type ResizeHandle, type ResizeStep } from './elementResizeRules'

/** One inline-style write: a value sets the property, `undefined` clears it. */
export type ResizeInlinePatch = Record<string, string | undefined>

/** The companion writes each axis's Fixed switch carries, computed once per gesture. */
export interface ResizeSizingPlan {
  width: SizingPatch
  height: SizingPatch
}

const NO_COMPANIONS: ResizeSizingPlan = { width: {}, height: {} }

/** `alignSelf` → `align-self`: the style key the source uses, as the name the CSSOM takes. */
export function cssPropertyName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/**
 * The layout the element is actually a child of: its nearest ancestor that
 * produces a box. A `display: contents` host (a design-system component's
 * node-id wrapper) lays nothing out, so its own parent is the container that
 * decides the element's flex or grid role.
 */
export function readSizingParentLayout(view: Window, element: Element): SizingParentLayout | null {
  let parent = element.parentElement
  for (let depth = 0; parent && depth < 8; depth += 1) {
    const style = view.getComputedStyle(parent)
    if (style.display !== 'contents') {
      return { display: style.display, flexDirection: style.flexDirection || 'row' }
    }
    parent = parent.parentElement
  }
  return null
}

/**
 * Read `read` from the element's computed style with the inline declarations
 * named in `clears` removed, then put them back — in the same task, so nothing
 * is painted in between; `getComputedStyle` here costs a style recalc of one
 * element, not a layout.
 */
function withInlineCleared<T>(view: Window, element: HTMLElement, clears: readonly string[], read: (style: CSSStyleDeclaration) => T): T {
  const saved = clears.map((key) => {
    const name = cssPropertyName(key)
    return { name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }
  })
  for (const { name } of saved) element.style.removeProperty(name)
  const result = read(view.getComputedStyle(element))
  for (const { name, value, priority } of saved) {
    if (value !== '') element.style.setProperty(name, value, priority)
  }
  return result
}

/** The element's cascade `flex-grow` / `flex-basis` with `clears` removed from its inline style. */
function probeFlexCascade(view: Window, element: HTMLElement, clears: readonly string[]): SizingFlexCascade {
  return withInlineCleared(view, element, clears, (style) => ({ flexGrow: style.flexGrow, flexBasis: style.flexBasis }))
}

function companionsFor(
  view: Window,
  element: HTMLElement,
  axis: SizingAxis,
  parent: SizingParentLayout,
  stored: Record<string, unknown>,
): SizingPatch {
  const base = sizingPatch('fixed', axis, parent, stored, '0px')
  const cascade = sizingAxisRole(axis, parent) === 'flex-main'
    ? probeFlexCascade(
        view,
        element,
        Object.entries(base).filter(([key, value]) => key !== axis && value === undefined).map(([key]) => key),
      )
    : undefined
  const { [axis]: _size, ...companions } = sizingPatch('fixed', axis, parent, stored, '0px', cascade)
  return companions
}

/**
 * The per-axis companion writes for a drag on `element`, whose stored inline
 * styles are `stored`. A positioned element (`start.offsets`) is out of flow —
 * no flex or grid role applies to it — and an element whose layout parent
 * cannot be read gets the size alone, which is what the resolver would say
 * for an unknown parent anyway.
 */
export function planResizeSizing(
  view: Window,
  element: HTMLElement,
  start: ResizeBoxStart,
  stored: Record<string, unknown>,
): ResizeSizingPlan {
  if (start.offsets) return NO_COMPANIONS
  const parent = readSizingParentLayout(view, element)
  if (!parent) return NO_COMPANIONS
  return {
    width: companionsFor(view, element, 'width', parent, stored),
    height: companionsFor(view, element, 'height', parent, stored),
  }
}

/**
 * Everything one step of the drag writes: the size (and offsets) from
 * `resizeStylePatch`, plus the Fixed companions of every axis whose size it
 * writes. `null` when the step moved nothing. The same object is the preview
 * and, on release, the commit.
 */
export function resizeInlinePatch(
  start: ResizeBoxStart,
  step: ResizeStep,
  plan: ResizeSizingPlan,
): ResizeInlinePatch | null {
  const size = resizeStylePatch(start, step)
  if (!size) return null
  const patch: ResizeInlinePatch = {}
  if (size.width !== undefined) Object.assign(patch, plan.width)
  if (size.height !== undefined) Object.assign(patch, plan.height)
  return Object.assign(patch, size)
}

/** The longhands a cleared shorthand has to be spelled as — a stylesheet cannot say "whatever the cascade says" for `flex` in one value. */
const CLEARED_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
}

/** CSS initial values of every property a Fixed switch can clear — what an engine that reports no computed value for one (a headless DOM) means by it. */
const INITIAL_VALUES: Readonly<Record<string, string>> = {
  'flex-grow': '0',
  'flex-shrink': '1',
  'flex-basis': 'auto',
  'align-self': 'auto',
  'justify-self': 'auto',
}

/**
 * What every property `plan` may CLEAR renders at once the element's own
 * inline declaration of it is gone: CSS property name → computed value, with
 * a cleared shorthand spelled as its longhands. Read once, at pointerdown, for
 * a stylesheet preview (see the module doc) — the portal's inline preview
 * never needs it.
 */
export function readClearedValues(view: Window, element: HTMLElement, plan: ResizeSizingPlan): Record<string, string> {
  const clears = [...new Set(
    [plan.width, plan.height].flatMap((axis) => Object.entries(axis).filter(([, value]) => value === undefined).map(([key]) => key)),
  )]
  if (clears.length === 0) return {}
  const names = clears.flatMap((key) => CLEARED_LONGHANDS[key] ?? [cssPropertyName(key)])
  return withInlineCleared(view, element, [...clears, ...names], (style) =>
    Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name) || (INITIAL_VALUES[name] ?? '')])),
  )
}

/**
 * The CSS declarations that PREVIEW `patch` from a stylesheet: every set
 * property as itself, every cleared one as the value `cleared`
 * ({@link readClearedValues}) says it renders at without its inline
 * declaration. Name → value pairs; the caller adds its own priority.
 */
export function stylesheetPreviewDeclarations(patch: ResizeInlinePatch, cleared: Readonly<Record<string, string>>): Array<[string, string]> {
  const declarations: Array<[string, string]> = []
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      declarations.push([cssPropertyName(key), value])
      continue
    }
    for (const name of CLEARED_LONGHANDS[key] ?? [cssPropertyName(key)]) {
      const renders = cleared[name]
      if (renders) declarations.push([name, renders])
    }
  }
  return declarations
}

/**
 * IX-6f — what a double-click on `handle` writes: Hug on every axis the
 * handle owns (an edge one axis, a corner both), through the inspector's own
 * resolver. `null` when the parent layout is unknown — Hug has no honest
 * write there (`sizingUnavailableReason`), and the caller says so.
 */
export function hugPatchForHandle(
  handle: ResizeHandle,
  parent: SizingParentLayout | null,
  stored: Record<string, unknown>,
): ResizeInlinePatch | null {
  if (!parent) return null
  const axes = resizeAxes(handle)
  const patch: ResizeInlinePatch = {}
  if (axes.width) Object.assign(patch, sizingPatch('hug', 'width', parent, stored, undefined))
  if (axes.height) Object.assign(patch, sizingPatch('hug', 'height', parent, stored, undefined))
  return Object.keys(patch).length > 0 ? patch : null
}
