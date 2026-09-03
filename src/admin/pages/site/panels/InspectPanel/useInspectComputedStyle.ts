/**
 * useInspectComputedStyle — resolves the selected node's REAL rendered
 * element inside a canvas iframe and reads its computed style.
 *
 * Deliberately a synchronous, render-time read (no `useEffect` + `useState`,
 * no RAF loop, no polling) — mirroring the existing
 * `useClassPickerDerivedState` pattern (`findRenderedCanvasNodeElement`
 * called straight from render). `getComputedStyle` is a pure read with no
 * side effects, so there's nothing to defer to an effect for.
 *
 * Recompute triggers: this only re-runs when the CALLER re-renders, and the
 * caller subscribes to exactly `selectedNodeId`, the selected node object,
 * and `activeBreakpointId` — so an unrelated store change never triggers an
 * extra DOM read. Within a render it recomputes because:
 *   - `selectedNodeId` changed (a different node is selected, or selection
 *     is cleared).
 *   - `selectedNode` object identity changed. The store's tree mutations go
 *     through Mutative, which produces a NEW object reference for a node
 *     whenever ANY of its own fields change (props, inlineStyles, classIds,
 *     label, ...) while leaving untouched siblings' references alone — so
 *     this fires exactly on "this node's own data changed", not on
 *     unrelated tree edits.
 *   - `activeBreakpointId` changed (switching device previews re-renders the
 *     frame at a different width, which can change computed values).
 *
 * Staleness caveat: a live edit to something the node's style *depends on*
 * but that isn't the node's own object — e.g. editing a shared class rule's
 * declarations, or an ancestor's inline style that this node inherits from
 * (font-family, color) — does NOT change this node's own object reference
 * and does NOT re-render this component, so the panel will not auto-refresh
 * for those edits until something re-renders it (e.g. re-selecting the
 * node).
 *
 * When multiple canvas frames have rendered the node (one per breakpoint),
 * the frame whose `data-breakpoint-id` matches the active breakpoint is
 * preferred; otherwise the first rendered match is used.
 *
 * ## Element-lookup cost — cached, not re-scanned every render (perf-01)
 *
 * "This only re-runs when the caller re-renders" was written when the
 * caller re-rendered once per SELECTION. `StyleSurface` (the Properties
 * panel's `useFrameComputedStyleValues` below) re-renders once per
 * KEYSTROKE that edits the selected node's style — and this panel, showing
 * the SAME node, re-renders right alongside it (`selectedNode`'s object
 * identity changes on every such edit, per the trigger list above). Each of
 * those re-renders used to redo the FULL element lookup from scratch:
 * `document.querySelectorAll('iframe')` over the whole admin document, then
 * a cross-document `frameDoc.querySelector('[data-node-id=…]')` INSIDE each
 * breakpoint iframe's own (arbitrarily large, user-authored) page — once per
 * open breakpoint frame, once per character typed.
 *
 * `RenderedCanvasNodeCache` (`canvasNodeLookup.ts`) now holds that lookup
 * across renders, one instance per hook call site (a `useState` lazy
 * initializer, not module-level — each mounted panel gets its own, so no
 * cross-panel leakage; see `useRenderedCanvasNodeCache`'s own doc for why
 * that's `useState` and not `useRef`). A cached entry is re-validated (not
 * blindly trusted) on every call — every element must still be `.isConnected`
 * and the live canvas-iframe count must be unchanged — so it self-heals on a
 * real remount (a structural edit, a frame reload, a breakpoint frame
 * opened/closed) instead of ever returning a stale element. See that class's
 * own doc for why `CanvasNodeElementCache` (the selection overlay's cache)
 * isn't directly reusable here.
 *
 * `getComputedStyle(element)` itself still runs on every call that reaches
 * it — it must, to stay correct, since the whole point of this hook firing
 * again is "the node's own data changed, go read what that produced." What
 * the cache removes is the redundant DOM SCAN that used to precede it; the
 * layout-forcing cost of the read itself is unchanged and would need a
 * browser profile to quantify (see this repo's task handoff for what was
 * proved by test vs. what still needs one).
 */
import { useState } from 'react'
import { RenderedCanvasNodeCache, type RenderedCanvasNode } from '@site/canvas/canvasNodeLookup'
import { useMutableBox } from '@site/hooks/useMutableBox'
import type { ComputedStyleSnapshot } from './inspectModel'

function frameBodyElement(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.body ?? null
  } catch (_err) {
    // Cross-origin iframe (a plugin or dev tool surface) — never a canvas frame.
    return null
  }
}

function pickPreferredElement(
  rendered: readonly RenderedCanvasNode[],
  activeBreakpointId: string,
): HTMLElement | null {
  if (rendered.length === 0) return null
  const preferred = rendered.find(
    (entry) => frameBodyElement(entry.frame)?.getAttribute('data-breakpoint-id') === activeBreakpointId,
  )
  return (preferred ?? rendered[0]).element
}

function resolveElement(
  cache: RenderedCanvasNodeCache,
  nodeId: string,
  activeBreakpointId: string,
): HTMLElement | null {
  cache.retainOnly(new Set([nodeId]))
  return pickPreferredElement(cache.resolve(nodeId), activeBreakpointId)
}

/**
 * Lazily-initialized, render-persistent cache — the lazy initializer runs
 * exactly once per mounted hook call site, same one-per-caller scoping
 * `BreakpointSelectionOverlay` gets from its own `CanvasNodeElementCache`
 * (that component uses `useRef` for it because it only ever reads the cache
 * from an effect/RAF tick, never during render itself — this hook needs the
 * opposite, see `useMutableBox`'s doc above for why that's `useState` here).
 */
function useRenderedCanvasNodeCache(): RenderedCanvasNodeCache {
  const [cache] = useState(() => new RenderedCanvasNodeCache())
  return cache
}

/**
 * Returns `next` unless it is shallow-equal (same keys, `===` values) to the
 * PREVIOUS object `ref` produced — in which case it hands back that previous
 * reference instead of `next`. `getComputedStyle` is still read fresh on
 * every call this render makes it to (see the module doc for why that read
 * itself can't be skipped without risking staleness); this only stops a
 * content-identical result from LOOKING like a change to every downstream
 * consumer.
 *
 * That matters because React Compiler auto-memoizes derived values based on
 * their inputs' referential identity — `StyleSurface`'s `provenanceByProperty`
 * map and the per-row placeholders it feeds are exactly the kind of
 * computation the compiler already skips re-running when its inputs didn't
 * change, but a `getComputedStyle` read rebuilding a brand-new object every
 * time (even when every string value inside it is identical) permanently
 * defeated that — every keystroke looked like "the computed style changed"
 * even on renders where nothing about it actually did (e.g. this same node
 * re-rendering for an unrelated reason, or a breakpoint switch that happens
 * to produce identical values). Takes the `{ current }` box from
 * `useMutableBox`, not `useMemo` — see that function's doc for why.
 */
function stabilizeRecord<T extends Record<string, string>>(box: { current: T | null }, next: T): T {
  const prev = box.current
  if (prev && shallowRecordEqual(prev, next)) return prev
  box.current = next
  return next
}

function shallowRecordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function readComputedStyleSnapshot(element: HTMLElement): ComputedStyleSnapshot | null {
  const view = element.ownerDocument.defaultView
  if (!view) return null
  const cs = view.getComputedStyle(element)
  return {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    borderTopColor: cs.borderTopColor,
    borderRightColor: cs.borderRightColor,
    borderBottomColor: cs.borderBottomColor,
    borderLeftColor: cs.borderLeftColor,
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    borderTopStyle: cs.borderTopStyle,
    borderRightStyle: cs.borderRightStyle,
    borderBottomStyle: cs.borderBottomStyle,
    borderLeftStyle: cs.borderLeftStyle,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    width: cs.width,
    height: cs.height,
    marginTop: cs.marginTop,
    marginRight: cs.marginRight,
    marginBottom: cs.marginBottom,
    marginLeft: cs.marginLeft,
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
  }
}

/**
 * `node` is accepted only to document the recompute contract (see module
 * doc) — the caller passing a fresh reference on relevant changes is what
 * makes this re-run; the value's fields aren't read here.
 */
export function useInspectComputedStyle(
  nodeId: string | null,
  node: unknown,
  activeBreakpointId: string,
): ComputedStyleSnapshot | null {
  void node
  const cache = useRenderedCanvasNodeCache()
  // Held as the widened `Record<string, string>` shape `stabilizeRecord`
  // operates on (every `ComputedStyleSnapshot` field IS a string — the
  // interface just names them instead of using an index signature, which is
  // all `stabilizeRecord` needs structurally). Narrowed back at the return
  // below; every value stored here was produced by `readComputedStyleSnapshot`,
  // which always returns a real `ComputedStyleSnapshot`.
  const snapshotBox = useMutableBox<Record<string, string>>()
  if (!nodeId) return null
  const element = resolveElement(cache, nodeId, activeBreakpointId)
  if (!element) return null
  const snapshot = readComputedStyleSnapshot(element)
  if (!snapshot) return null
  // `stabilizeRecord`'s box parameter is invariant in `T` (it both reads AND
  // writes `box.current`), so TS can't unify a fixed-key interface with the
  // `Record<string, string>` box declared above through generic inference
  // alone, even though every field genuinely IS a string. Widen through
  // `unknown` at this one boundary — safe because `readComputedStyleSnapshot`
  // is the only producer of a value stored here, and it always returns a real
  // `ComputedStyleSnapshot`.
  const stabilized = stabilizeRecord(snapshotBox, snapshot as unknown as Record<string, string>)
  return stabilized as unknown as ComputedStyleSnapshot
}

/**
 * Track F1 — the generalized sibling of `useInspectComputedStyle`, for the
 * Properties Panel rather than the read-only Inspect panel. Reads
 * `getComputedStyle` for an ARBITRARY set of CSS property keys (camelCase,
 * the same naming `CSSStyleDeclaration`/`CSSPropertyBag` both use) instead of
 * a fixed shape — the Properties Panel curates ~90 properties across its
 * sections (`ALL_CURATED_CSS_PROPERTIES`), far more than `ComputedStyleSnapshot`
 * models, and every one of them is a legitimate camelCase accessor on a real
 * `CSSStyleDeclaration` (the CSS2Properties convenience interface every
 * browser implements).
 *
 * Same synchronous, render-time read as `useInspectComputedStyle` — no
 * `useEffect`/`useState`, no polling — for the same reason: `getComputedStyle`
 * is a pure read with no side effects, and the caller already re-renders on
 * every relevant change (selection, breakpoint, and — for the Properties
 * Panel specifically — every keystroke that edits the selected node, since
 * that keystroke's own store write already changes the node's object
 * identity and re-renders the panel to show it; this read does not add an
 * EXTRA re-render, it piggybacks the one already happening). It does not
 * cascade to other frames or other nodes — the caller's own subscriptions
 * (`selectedNodeId`, `selectedNode`, `activeBreakpointId`) are the only
 * narrow slice driving it, same discipline the C3 track's narrow-slice fix
 * used for whole-`site` selectors.
 *
 * Returns `null` when the node has no rendered element yet (no canvas
 * mounted — e.g. every existing panel test, which render `PropertiesPanel`
 * with no live iframe). Callers must treat `null` as "no frame truth
 * available" and fall back to the existing spec-default table, not as
 * "everything is unset."
 */
/**
 * The rendered PARENT's `display` + `flex-direction`, or `null` when the node
 * has no rendered element (nothing mounted, a global-selector edit) or is the
 * document root.
 *
 * Its own hook rather than two more entries in `useFrameComputedStyleValues`'
 * property list because the subject is a DIFFERENT element. "Fill container"
 * and "Hug contents" are questions about the container, and the container's
 * layout is the only thing that decides which declaration expresses them —
 * see `elementSizing.ts`. Reading the node's own `display` instead is the
 * classic way to get this wrong.
 *
 * Same synchronous render-time read, same cache, and the same staleness
 * caveat as the hook below: an edit to the PARENT's own layout does not change
 * this node's object identity, so the segmented control can show the previous
 * container's answer until something re-renders the panel.
 */
export function useFrameParentLayout(
  nodeId: string | null,
  activeBreakpointId: string,
): { display: string; flexDirection: string } | null {
  const cache = useRenderedCanvasNodeCache()
  const layoutBox = useMutableBox<{ display: string; flexDirection: string }>()
  if (!nodeId) return null
  const element = resolveElement(cache, nodeId, activeBreakpointId)
  const parent = element?.parentElement
  if (!parent) return null
  const view = parent.ownerDocument.defaultView
  if (!view) return null
  const cs = view.getComputedStyle(parent)
  return stabilizeRecord(layoutBox, {
    display: cs.display,
    flexDirection: cs.flexDirection,
  })
}

export function useFrameComputedStyleValues(
  nodeId: string | null,
  activeBreakpointId: string,
  properties: ReadonlyArray<string>,
): Record<string, string> | null {
  const cache = useRenderedCanvasNodeCache()
  const valuesBox = useMutableBox<Record<string, string>>()
  if (!nodeId) return null
  const element = resolveElement(cache, nodeId, activeBreakpointId)
  if (!element) return null
  const view = element.ownerDocument.defaultView
  if (!view) return null
  const cs = view.getComputedStyle(element) as unknown as Record<string, string>
  const values: Record<string, string> = {}
  for (const prop of properties) {
    values[prop] = cs[prop] ?? ''
  }
  return stabilizeRecord(valuesBox, values)
}
