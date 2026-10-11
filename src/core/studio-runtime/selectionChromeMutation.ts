/**
 * isSelectionChromeMutation — "this DOM mutation is the editor's own
 * selection chrome, not the page" (audit PERF-2).
 *
 * The rings, the node badge, the resize handles and the Alt-measure layer all
 * live INSIDE the frame document (`selectionChromeCss.ts` explains why), in a
 * zero-size overlay root appended to `<body>`, with one `<style>` in `<head>`.
 * Four observers watch that same document for "the page changed":
 *
 *   - the portal frame's auto-height refit (`useIframeFrameAutoHeight` →
 *     `frameFitMutationScheduler`), which resets the fit pin and re-runs
 *     `collectScrollDeficits` — a forced layout over every element;
 *   - the scroll-unroll pass (`startScrollUnroll`), which snapshots and
 *     re-classifies every element — a second forced layout;
 *   - the overlay's own measure scheduler (`overlayMeasureScheduler`);
 *   - the live runtime's layout observer (`runtime.ts`).
 *
 * A hover ring appearing is a `childList` record under `<body>`. Before this
 * predicate existed only the last two filtered it, so every hover crossing
 * and every selection change re-ran both full-document layout passes in the
 * frame — and a Layers-panel hover armed chrome in every mounted frame at
 * once. ONE predicate, used by all four, so the definition of "chrome"
 * cannot drift between them.
 *
 * Cross-realm by construction: records come from another window, so this
 * duck-types on `nodeType` and never uses `instanceof`.
 */
import { SELECTION_OVERLAY_ROOT_ID, SELECTION_STYLE_TAG_ID } from './selectionChromeCss'

const CHROME_ROOT_SELECTOR = `#${SELECTION_OVERLAY_ROOT_ID}, #${SELECTION_STYLE_TAG_ID}`
const ELEMENT_NODE = 1

interface ClosestCapable {
  closest(selector: string): unknown
}

/** The element a node belongs to: itself when it is one, else its parent (text inside the chrome `<style>`). */
function owningElement(node: Node | null): ClosestCapable | null {
  if (!node) return null
  if (node.nodeType === ELEMENT_NODE) return node as unknown as ClosestCapable
  return (node.parentElement as unknown as ClosestCapable | null) ?? null
}

/** True when `node` is the overlay root, the chrome stylesheet, or anything inside either. */
export function isSelectionChromeNode(node: Node | null): boolean {
  const element = owningElement(node)
  return element !== null && element.closest(CHROME_ROOT_SELECTOR) !== null
}

/**
 * True when `record` is ENTIRELY the editor's selection chrome:
 *
 *   - anything whose target is inside the overlay root or the chrome
 *     `<style>` (a ring added/removed/restyled, the stylesheet's text), or
 *   - a `childList` record on an ancestor (`<body>`, `<head>`) whose every
 *     added and removed node is chrome — the overlay root or the stylesheet
 *     themselves being mounted or torn down.
 *
 * A record that mixes chrome with real content is NOT chrome: the content
 * half is a real change and must still reach the observer.
 */
export function isSelectionChromeMutation(record: MutationRecord): boolean {
  if (isSelectionChromeNode(record.target)) return true
  if (record.type !== 'childList') return false
  const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
  return touched.length > 0 && touched.every((node) => isSelectionChromeNode(node))
}
