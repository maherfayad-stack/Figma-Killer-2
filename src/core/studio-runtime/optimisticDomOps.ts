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
 *
 * ## Never detach or move a node React owns (`live-14`)
 *
 * The app's React root reconciles the NEXT render against the DOM it built,
 * by sibling position. A delete that physically removed the selected node
 * left that fiber's DOM detached; when HMR then re-rendered `[A, B, C]` as
 * `[A, C]`, React updated B's (detached, invisible) node into C and removed
 * C's own node — so the user watched the element BELOW the one they deleted
 * disappear too, until a full reload. A move that reparented a node broke the
 * same contract the other way round.
 *
 * So a delete only HIDES ({@link OPTIMISTIC_HIDDEN_ATTR} + one runtime-owned
 * stylesheet rule — never the element's inline `style`, which React also
 * writes), a move is recorded in a per-document ledger, and
 * {@link revertOptimisticDom} puts everything back the instant Vite announces
 * an update (`vite:beforeUpdate`), before React reconciles. The real change
 * then arrives from the source, through React, on a DOM React recognises.
 */
import { DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES } from './messages'
import { findNthNodeById } from './nodeIdIndexing'

const NODE_ID_ATTR = 'data-node-id'

/** Marks an element this module created, so a later sweep can find every one of them. */
export const OPTIMISTIC_ATTR = 'data-studio-optimistic'
/** Marks a node an optimistic delete hid — the node itself stays where React put it. */
export const OPTIMISTIC_HIDDEN_ATTR = 'data-studio-optimistic-hidden'
const OPTIMISTIC_STYLE_ID = 'studio-runtime-optimistic'

interface MoveRecord {
  el: Element
  parent: ParentNode
  next: Node | null
}

/** Per-document record of what an optimistic move displaced, so it can be put back before React reconciles. */
const moveLedgers = new WeakMap<Document, MoveRecord[]>()

function ensureOptimisticStylesheet(doc: Document): void {
  if (doc.getElementById(OPTIMISTIC_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = OPTIMISTIC_STYLE_ID
  style.setAttribute('data-source', 'studio-runtime')
  style.textContent = `[${OPTIMISTIC_HIDDEN_ATTR}] { display: none !important; }`
  doc.head?.appendChild(style)
}

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

/** Hides the node — see "Never detach or move a node React owns" above. */
export function applyOptimisticDelete(doc: Document, nodeId: string, occurrenceIndex: number): void {
  const el = findNthNodeById(doc, nodeId, occurrenceIndex)
  if (!el) return
  ensureOptimisticStylesheet(doc)
  el.setAttribute(OPTIMISTIC_HIDDEN_ATTR, '')
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
  if (!el || !parent || !el.parentNode) return
  let ledger = moveLedgers.get(doc)
  if (!ledger) {
    ledger = []
    moveLedgers.set(doc, ledger)
  }
  ledger.push({ el, parent: el.parentNode, next: el.nextSibling })
  parent.insertBefore(el, parent.children[index] ?? null)
}

/**
 * Puts every optimistic move back where React left it (latest first) and
 * un-hides every optimistic delete — called on `vite:beforeUpdate`, before
 * React reconciles the update, and again on `vite:afterUpdate` in case the
 * frame never saw the "before" (a full reload). Idempotent.
 */
export function revertOptimisticDom(doc: Document): void {
  const ledger = moveLedgers.get(doc) ?? []
  for (const record of ledger.reverse()) {
    if (!record.parent.isConnected) continue
    const next = record.next && record.next.parentNode === record.parent ? record.next : null
    record.parent.insertBefore(record.el, next)
  }
  moveLedgers.delete(doc)
  doc.querySelectorAll(`[${OPTIMISTIC_HIDDEN_ATTR}]`).forEach((el) => el.removeAttribute(OPTIMISTIC_HIDDEN_ATTR))
}

/**
 * store-17 — take back the optimistic hide and move of exactly these nodes:
 * a structural write the server refused, or never answered, produces no HMR,
 * so {@link revertOptimisticDom} never runs for it. Every other node's
 * optimistic state is left alone — a second gesture whose write is still in
 * flight keeps its preview. A node's moves are undone latest first. A moved
 * element is found in the ledger by its stamp when only one element with that
 * stamp was moved — the move changed its document order, so its occurrence
 * index may no longer point at it — and by the ref otherwise.
 */
export function revertOptimisticNodes(doc: Document, refs: readonly { nodeId: string; occurrenceIndex: number }[]): void {
  const ledger = moveLedgers.get(doc) ?? []
  for (const ref of refs) {
    const movedElements = new Set(ledger.filter((record) => record.el.getAttribute(NODE_ID_ATTR) === ref.nodeId).map((record) => record.el))
    const own = movedElements.size === 1 ? [...movedElements][0]! : findNthNodeById(doc, ref.nodeId, ref.occurrenceIndex)
    if (!own) continue
    for (const record of ledger.filter((entry) => entry.el === own).reverse()) {
      ledger.splice(ledger.indexOf(record), 1)
      if (!record.parent.isConnected) continue
      const next = record.next && record.next.parentNode === record.parent ? record.next : null
      record.parent.insertBefore(record.el, next)
    }
    own.removeAttribute(OPTIMISTIC_HIDDEN_ATTR)
  }
}

export function applyOptimisticText(doc: Document, nodeId: string, occurrenceIndex: number, text: string): void {
  const el = findNthNodeById(doc, nodeId, occurrenceIndex)
  if (el) el.textContent = text
}

/** Clears every optimistic placeholder and any leftover hide/move — called on `vite:afterUpdate`, which fires once the new DOM exists. */
export function sweepOptimisticGhosts(doc: Document): void {
  doc.querySelectorAll(`[${OPTIMISTIC_ATTR}]`).forEach((el) => el.remove())
  revertOptimisticDom(doc)
}
