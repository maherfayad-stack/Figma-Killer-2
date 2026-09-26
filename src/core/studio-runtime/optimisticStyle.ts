/**
 * optimisticStyle — `speed-01`: the same-tick style preview a live frame
 * shows for a properties-panel commit or scrub, ahead of the file write +
 * Vite HMR round trip that follows within milliseconds (measured before this
 * landed: 2.18s from a panel number edit to the frame changing — a fixed 2s
 * autosave debounce plus the round trip itself; `speed-02` shrinks the
 * debounce, this file removes the WAIT from what the user sees at all).
 *
 * ## A stylesheet rule, never `element.style` (the `live-13` resize-preview posture)
 *
 * `resizeHandles.ts` established the pattern this module generalises: the
 * eventual real value arrives through React (the file write lands, Vite HMR
 * re-renders with the SAME inline style or class the panel just committed),
 * so an inline `element.style` preview could never be cleared safely —
 * removing it after the commit deletes React's own write, removing it before
 * snaps the element back for the length of the round trip. A stylesheet rule
 * shares nothing with what React writes, so it can stay up until the real
 * value lands and be dropped without touching it.
 *
 * ## ALWAYS element-scoped — even for a class-target write (corrected live)
 *
 * The original design keyed a class-target rule on `.${className}` directly,
 * reaching every element carrying that class in one shot. Dogfooding this
 * against a real project (a class-target Width edit on `test4`'s SMS page)
 * showed that rule matches NOTHING: `className` is the name Studio's own
 * PARSE gives the class (`SMS_page__5638d`, read out of the CSS-module
 * source), but the live frame's DOM carries whatever name VITE'S OWN
 * CSS-modules plugin generated at dev-server build time
 * (`_page_xxxxx_3`-shaped) — two independent hashing schemes over the same
 * source that have no reason to agree, and did not. The runtime has no way
 * to learn Vite's name for a class from inside the frame.
 *
 * So a class-target write previews the SAME way an inline-target write does:
 * element-scoped, via {@link OPTIMISTIC_STYLE_ATTR} on the specific node
 * `ref` names (the node the panel is editing) — never a class selector.
 * `className` still crosses the wire (`messages.ts`'s
 * `OptimisticStyleMessageSchema`) but is now purely INFORMATIONAL here; this
 * module does not read it. Only the edited node's own element gets the
 * instant preview; every other element sharing the class (a second row using
 * the same component, say) still catches up on the next HMR update, same as
 * before this file existed — an acceptable narrowing for a PREVIEW, which
 * only ever needs to look right at the one thing being edited.
 *
 * Rules are kept in ONE `Map` per document, keyed by `ref` (`refKey` below) —
 * "per-node rules in a Map so re-applies replace, not append": scrubbing the
 * same field again overwrites its own entry rather than accumulating a stale
 * copy, and {@link clearOptimisticStyle} removes exactly the one entry a
 * given ref is holding.
 *
 * ## Never confused with a real content mutation
 *
 * Writing {@link OPTIMISTIC_STYLE_ATTR} onto an element is a DOM mutation
 * `runtime.ts`'s `layoutObserver` (watching `doc.body` for real content
 * changes, to know when to re-derive the frame's fit height) would otherwise
 * see — except that it is an ATTRIBUTE record, and `frameFitMutationScheduler`
 * never resets a fit for an attribute-only batch (PERF-9), the same reason
 * `resizeHandles.ts`'s own preview stamp is never mistaken for content.
 *
 * ## Reverted before React reconciles, cleared again after
 *
 * `revertAllOptimisticStyle` is called from BOTH `vite:beforeUpdate` and
 * `vite:afterUpdate` (idempotent — the second call is a no-op if the first
 * already ran), the same "revert before, sweep after" shape
 * `optimisticDomOps.ts` uses for insert/delete/move. Unlike a structural
 * mutation, a style rule cannot corrupt React's positional reconciliation —
 * but the source is about to carry the real value either way, so the
 * preview's job is done the moment the update lands.
 */
import { findNthNodeById } from './nodeIdIndexing'

/** Stamped on the target element for an optimistic style (inline OR class target — see the module doc) — `runtime.ts`'s layout observer ignores writes to this attribute. */
export const OPTIMISTIC_STYLE_ATTR = 'data-studio-optimistic-style'
const OPTIMISTIC_STYLE_TAG_ID = 'studio-runtime-optimistic-style'

interface StyleRuleEntry {
  /** The element {@link OPTIMISTIC_STYLE_ATTR} was stamped on, so `clearOptimisticStyle` can remove it again. */
  element: Element
  css: string
}

/** One rule map per document — a bridge frame's runtime only ever manages its own document, but tests construct more than one `Document` in a single process. */
const documentRules = new WeakMap<Document, Map<string, StyleRuleEntry>>()
const elementStamps = new WeakMap<Element, string>()
let stampCounter = 0

function ruleMap(doc: Document): Map<string, StyleRuleEntry> {
  let map = documentRules.get(doc)
  if (!map) {
    map = new Map()
    documentRules.set(doc, map)
  }
  return map
}

function refKey(ref: { nodeId: string; occurrenceIndex: number }): string {
  return `${ref.nodeId}#${ref.occurrenceIndex}`
}

/**
 * `backgroundColor` -> `background-color`; a CSS custom property (`--foo`)
 * passes through unchanged. A small, self-contained copy rather than an
 * import of `@core/css-codemods`'s `camelToKebabCssProperty` — this file
 * ships inside the runtime bundle served to a real browser (see that
 * module's own doc for why every "ships to the browser" leaf keeps its own
 * copy of this one-line conversion instead of reaching across a Node-only
 * boundary for it).
 */
function toKebabCssProperty(name: string): string {
  return name.startsWith('--') ? name : name.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
}

function declarationsFor(patch: Readonly<Record<string, string>>): string {
  return Object.entries(patch)
    .map(([prop, value]) => `${toKebabCssProperty(prop)}: ${value} !important;`)
    .join(' ')
}

function ensureStylesheet(doc: Document): HTMLStyleElement {
  let style = doc.getElementById(OPTIMISTIC_STYLE_TAG_ID) as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = OPTIMISTIC_STYLE_TAG_ID
    style.setAttribute('data-source', 'studio-runtime')
    doc.head?.appendChild(style)
  }
  return style
}

function writeStylesheet(doc: Document): void {
  const map = ruleMap(doc)
  if (map.size === 0) {
    doc.getElementById(OPTIMISTIC_STYLE_TAG_ID)?.remove()
    return
  }
  ensureStylesheet(doc).textContent = [...map.values()].map((entry) => entry.css).join('\n')
}

/**
 * Applies (or replaces) the optimistic style rule for `ref`, always scoped to
 * `ref`'s own element — see the module doc, "ALWAYS element-scoped", for why
 * a class-target write (the caller's `className` is intentionally not a
 * parameter here) previews the same way an inline-target write does. A no-op
 * when `patch` is empty, or when `ref` does not resolve to an element in
 * `doc` (removed, not yet rendered, or the wrong occurrence).
 */
export function applyOptimisticStyle(
  doc: Document,
  ref: { nodeId: string; occurrenceIndex: number },
  patch: Readonly<Record<string, string>>,
): void {
  const declarations = declarationsFor(patch)
  if (!declarations) return

  const element = findNthNodeById(doc, ref.nodeId, ref.occurrenceIndex)
  if (!element) return
  let stamp = elementStamps.get(element)
  if (!stamp) {
    stamp = `s${stampCounter++}`
    elementStamps.set(element, stamp)
  }
  element.setAttribute(OPTIMISTIC_STYLE_ATTR, stamp)
  const selector = `[${OPTIMISTIC_STYLE_ATTR}="${stamp}"]`

  ruleMap(doc).set(refKey(ref), { element, css: `${selector} { ${declarations} }` })
  writeStylesheet(doc)
}

/** Drops the one rule currently keyed on `ref`. A no-op when `ref` has no active rule. */
export function clearOptimisticStyle(doc: Document, ref: { nodeId: string; occurrenceIndex: number }): void {
  const map = ruleMap(doc)
  const key = refKey(ref)
  const entry = map.get(key)
  if (!entry) return
  entry.element.removeAttribute(OPTIMISTIC_STYLE_ATTR)
  map.delete(key)
  writeStylesheet(doc)
}

/** Drops every optimistic style rule and every element stamp — see the module doc, "reverted before React reconciles, cleared again after". Idempotent. */
export function revertAllOptimisticStyle(doc: Document): void {
  const map = ruleMap(doc)
  if (map.size === 0) return
  for (const entry of map.values()) entry.element.removeAttribute(OPTIMISTIC_STYLE_ATTR)
  map.clear()
  doc.getElementById(OPTIMISTIC_STYLE_TAG_ID)?.remove()
}
