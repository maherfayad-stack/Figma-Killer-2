/**
 * optimisticDomOps — the four immediate DOM mutations a live frame performs
 * for the paint-on-drop feel, ahead of the HMR/writeback reconciliation that
 * follows within milliseconds.
 *
 * Extracted out of `runtime.ts` (module-size-budgets gate): "apply a
 * placeholder mutation to this document" is a distinct responsibility from
 * "be the postMessage bridge", it needs nothing from the bridge's closure but
 * the `Document`, and keeping it small and separate makes the one genuinely
 * security-sensitive rule in it auditable at a glance —
 *
 * ## Never `innerHTML`, and never a dangerous tag
 *
 * `optimistic.insert` carries STRUCTURED fields (`tagName`, `text`), not an
 * HTML string, precisely so there is no parse-and-execute surface for what is,
 * in the end, a placeholder HMR replaces within milliseconds. Elements are
 * built with `document.createElement` and all text goes through
 * `Node.textContent`.
 *
 * The `DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES` check is case-INSENSITIVE and
 * lives here rather than in the schema's regex, because
 * `document.createElement` normalizes an HTML tag name's case regardless of
 * how it was spelled — `SCRIPT`/`Script` must be caught the same as `script`.
 * See `messages.ts`'s own doc on that set for why this is defense in depth
 * rather than the only guard.
 *
 * Every insert is tagged {@link OPTIMISTIC_ATTR} so
 * {@link sweepOptimisticGhosts} can clear every placeholder once Vite has
 * landed the real element (`live-07`). Without that sweep a successful insert
 * leaves a permanent duplicate; a refusal that writes no file never fires it,
 * which is the same limitation portal mode already has.
 */
import { DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES } from './messages'
import { findNthNodeById } from './nodeIdIndexing'

const NODE_ID_ATTR = 'data-node-id'

/** Marks an element this module created, so a later sweep can find every one of them. */
export const OPTIMISTIC_ATTR = 'data-studio-optimistic'

export interface OptimisticInsert {
  nodeId: string
  parentNodeId: string
  parentOccurrenceIndex: number
  index: number
  tagName: string
  text?: string
}

export function applyOptimisticInsert(doc: Document, op: OptimisticInsert): void {
  if (DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES.has(op.tagName.toLowerCase())) return
  const parent = findNthNodeById(doc, op.parentNodeId, op.parentOccurrenceIndex)
  if (!parent) return
  const el = doc.createElement(op.tagName)
  el.setAttribute(NODE_ID_ATTR, op.nodeId)
  el.setAttribute(OPTIMISTIC_ATTR, '')
  if (op.text !== undefined) el.textContent = op.text
  parent.insertBefore(el, parent.children[op.index] ?? null)
}

export function applyOptimisticDelete(doc: Document, nodeId: string, occurrenceIndex: number): void {
  findNthNodeById(doc, nodeId, occurrenceIndex)?.remove()
}

export function applyOptimisticMove(
  doc: Document,
  nodeId: string,
  occurrenceIndex: number,
  parentNodeId: string,
  parentOccurrenceIndex: number,
  index: number,
): void {
  const el = findNthNodeById(doc, nodeId, occurrenceIndex)
  const parent = findNthNodeById(doc, parentNodeId, parentOccurrenceIndex)
  if (!el || !parent) return
  parent.insertBefore(el, parent.children[index] ?? null)
}

export function applyOptimisticText(doc: Document, nodeId: string, occurrenceIndex: number, text: string): void {
  const el = findNthNodeById(doc, nodeId, occurrenceIndex)
  if (el) el.textContent = text
}

/** Clears every optimistic placeholder — called on `vite:afterUpdate`, which fires once the new DOM exists. */
export function sweepOptimisticGhosts(doc: Document): void {
  doc.querySelectorAll(`[${OPTIMISTIC_ATTR}]`).forEach((el) => el.remove())
}
