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
 * own Fixed switch, `sizingPatch('fixed', …)` in `elementSizing.ts`. That is
 * one resolver for "make this axis Fixed" whether the user clicked the W
 * field's mode menu or dragged an edge — the companion writes (dropping a
 * Fill marker, `align-self: stretch`, overriding a cascade `flex`) cannot
 * drift between the two.
 *
 * The one thing the canvas knows that the panel does not is the element's
 * CASCADE: a `flex: 1` in a class survives clearing every inline marker. The
 * drag reads it once, at pointerdown (`probeFlexCascade`), and hands it to the
 * resolver.
 *
 * The preview applies the SAME patch the commit writes (`createInlineStylePreview`),
 * because a preview that only moved `width` would lie for the whole drag on a
 * flex item. It snapshots every property it touches and restores the
 * originals before the store commit, so React's re-render is the last thing
 * to write them — the preview-then-commit contract `useElementResizeDrag`
 * documents.
 *
 * ## Double-click a handle: Hug (P5-F, IX-6f)
 *
 * Figma's gesture: double-clicking an edge handle sets that axis to Hug
 * contents, a corner both axes. {@link hugPatchForHandle} is that write, and
 * it is the inspector's own `sizingPatch('hug', …)` for each axis, against
 * the same parent layout the drag reads — so the canvas and the W/H mode
 * menu can never write different CSS for "Hug".
 */
import {
  sizingAxisRole,
  sizingPatch,
  type SizingAxis,
  type SizingFlexCascade,
  type SizingParentLayout,
  type SizingPatch,
} from '@site/panels/PropertiesPanel/elementSizing'
import { resizeAxes, resizeStylePatch, type ResizeBoxStart, type ResizeHandle, type ResizeStep } from '@core/studio-runtime'

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
 * The element's cascade `flex-grow` / `flex-basis` with `clears` removed from
 * its inline style — the value the resolver needs to know whether a width
 * alone would render. The clears are put back before returning, in the same
 * task, so nothing is painted in between; `getComputedStyle` here costs a
 * style recalc of one element, not a layout.
 */
function probeFlexCascade(view: Window, element: HTMLElement, clears: readonly string[]): SizingFlexCascade {
  const saved = clears.map((key) => {
    const name = cssPropertyName(key)
    return { name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }
  })
  for (const { name } of saved) element.style.removeProperty(name)
  const style = view.getComputedStyle(element)
  const cascade = { flexGrow: style.flexGrow, flexBasis: style.flexBasis }
  for (const { name, value, priority } of saved) {
    if (value !== '') element.style.setProperty(name, value, priority)
  }
  return cascade
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

export interface InlineStylePreview {
  /** Show `patch` on the element; a property a previous call touched and this one does not is restored. */
  apply(patch: ResizeInlinePatch): void
  /** Restore every touched property to what React last wrote. */
  clear(): void
}

/**
 * A preview written straight onto the element's own `style`, restorable to the
 * exact inline values it found. Clears run before sets, because clearing a
 * longhand (`flex-grow`) after setting its shorthand (`flex`) would unset
 * part of the value just written.
 */
export function createInlineStylePreview(element: HTMLElement): InlineStylePreview {
  const originals = new Map<string, { value: string; priority: string }>()

  const remember = (name: string) => {
    if (originals.has(name)) return
    originals.set(name, { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })
  }
  const restore = (names: Iterable<string>) => {
    // The `flex` shorthand first, so a restored longhand is not reset by it.
    const ordered = [...names].sort((a, b) => Number(b === 'flex') - Number(a === 'flex'))
    for (const name of ordered) {
      const original = originals.get(name)
      if (!original) continue
      if (original.value === '') element.style.removeProperty(name)
      else element.style.setProperty(name, original.value, original.priority)
      originals.delete(name)
    }
  }

  return {
    apply(patch) {
      const entries = Object.entries(patch).map(([key, value]) => [cssPropertyName(key), value] as const)
      const touched = new Set(entries.map(([name]) => name))
      restore([...originals.keys()].filter((name) => !touched.has(name)))
      for (const [name, value] of entries) {
        remember(name)
        if (value === undefined) element.style.removeProperty(name)
      }
      for (const [name, value] of entries) {
        if (value !== undefined) element.style.setProperty(name, value)
      }
    },
    clear() {
      restore([...originals.keys()])
    },
  }
}
