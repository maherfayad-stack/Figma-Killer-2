/**
 * liveNodeResolve — maps one live DOM element in a running dev-server frame
 * back to the tree node id `parsePageFile` minted for it.
 *
 * ## Why this exists at all
 *
 * The Vite plugin (`vitePlugin.ts` → `idStamp.ts`) stamps `data-node-id` with
 * `toRuntimeStampId` — the PLAIN `rel:line:col` shape, always, because it
 * reads one file in isolation and has no call-site or `.map`-iteration
 * knowledge. The parser's own tree, by contrast, can hold TWO shapes the
 * plugin can never produce for the same element:
 *
 *   - an INLINED node's composite id — `callSite~component:line:col` — when a
 *     local component's own file was spliced into a page's tree
 *     (`inlineLocalComponents`, `@core/page-parser`). Every call site of that
 *     component renders the SAME stamped element (Babel only ever saw the
 *     component's own file once), so N call sites on one page all render DOM
 *     carrying the identical `data-node-id`.
 *   - a `.map` ROW's suffixed id — `…:line:col#0`, `#1`, `#2` — when a fully
 *     resolved array was expanded into N tree nodes from ONE source JSX
 *     expression (`staticLoopExpansion`). All N rows render DOM carrying the
 *     identical `data-node-id` too, for the same reason.
 *
 * Both mismatches reduce to the SAME question: "the DOM has several elements
 * sharing one stamp id; which real tree node id does THIS ONE (the element
 * that was actually clicked) correspond to?" That is answered with ONE
 * positional-pairing mechanism, not two: this element's OCCURRENCE INDEX among
 * every DOM element sharing its stamp id, in document order, is paired with
 * the SAME stamp's real node ids in TREE order. Document order and tree order
 * are the same order for anything this parser produces — every node is
 * visited exactly once, in source order, and a `.map` row or a component call
 * site is expanded/inlined in place, not reordered — so the Nth stamped
 * element in the DOM is the Nth real node id sharing that stamp.
 *
 * A third, genuinely different case exists too: an element the plugin never
 * stamped at all (vendor markup, a package component's own internals, plain
 * intrinsic elements a package renders past Studio's parse boundary). For
 * that one there is no occurrence index to compute — the honest answer is the
 * nearest ANCESTOR that does carry a stamp, reported as inexact so a caller
 * can badge it rather than pretend the click landed on a real tree node.
 */
import { INLINE_ID_SEPARATOR, LOOP_ID_SEPARATOR } from '@core/page-tree'

/** The attribute `idStamp.ts` writes and this module reads back. Mirrors `idStamp.ts`'s own `STUDIO_NODE_ID_ATTR` — kept as a second literal on purpose: importing `idStamp.ts` here would drag `@babel/core` into whatever bundle imports `liveNodeResolve` (the canvas/admin bundle), which is exactly the isolation `@core/studio-runtime`'s barrel exists to protect. See this module's barrel comment. */
export const STUDIO_NODE_ID_ATTR = 'data-node-id'

/**
 * The minimal DOM surface this module needs — satisfied by a real `Element`
 * in any document (an iframe's, `happy-dom`'s, jsdom's) without importing a
 * DOM lib type that couples this module to one runtime.
 */
export interface LiveElementLike {
  getAttribute(name: string): string | null
  readonly parentElement: LiveElementLike | null
}

/**
 * Strips a real tree node id down to the "stamp id" the plugin could have
 * produced for it: keep the composite id's TAIL (the component's own file —
 * splitting on `~` FIRST is the same non-negotiable order every writeback
 * path in this codebase already follows, see `sourceNodeId.ts`), then strip
 * any trailing `.map`-iteration suffixes (`#0`, `#1`, …; nested loops append
 * one per level).
 */
export function toStampId(nodeId: string): string {
  const tail = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  const loopSuffix = new RegExp(`(\\${LOOP_ID_SEPARATOR}\\d+)+$`)
  return tail.replace(loopSuffix, '')
}

/**
 * Groups real tree node ids by the stamp id they'd share on the live DOM.
 * `nodeIdsInTreeOrder` must be visited in the SAME order the parser produced
 * them (an object's own key order, for a `ParsedPage`/`PageTree`'s node map,
 * already is that order — insertion order, which for a string-keyed object is
 * preserved) — `resolveLiveNode`'s positional pairing depends on it.
 */
export function buildStampIndex(nodeIdsInTreeOrder: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const nodeId of nodeIdsInTreeOrder) {
    const stampId = toStampId(nodeId)
    const bucket = index.get(stampId)
    if (bucket) bucket.push(nodeId)
    else index.set(stampId, [nodeId])
  }
  return index
}

export interface LiveNodeMatch {
  /** The real tree node id this DOM element most likely renders. */
  nodeId: string
  /**
   * `false` when this is the nearest STAMPED ANCESTOR's id, not the clicked
   * element's own identity (the element itself carried no `data-node-id` —
   * vendor/package-internal markup) — or when occurrence pairing ran out of
   * candidates for its stamp (a runtime-only element the parser never
   * produced a node for). A caller should badge an inexact match rather than
   * act on it as if the user had selected that node directly.
   */
  exact: boolean
}

export interface ResolveLiveNodeOptions {
  /** stamp id -> real node ids, in tree order — from `buildStampIndex`. */
  index: ReadonlyMap<string, readonly string[]>
  /**
   * Every element in the frame's document sharing `stampId`, in DOCUMENT
   * order. Typically `Array.from(frameDocument.querySelectorAll(`[data-node-id="${stampId}"]`))`
   * — left to the caller because "the frame's document" is an iframe concern
   * this module has no opinion on (see `docs/agent-refs/canvas-internals.md`
   * on why canvas DOM queries never use the top-level `document`).
   */
  occurrencesOf(stampId: string): readonly LiveElementLike[]
}

/**
 * Maps one live DOM element back to the real tree node id it renders.
 *
 * Returns `null` only when NEITHER the element nor any ancestor carries a
 * `data-node-id` the plugin could have written (walked past the document
 * root) — there is nothing this module can say about such an element at all.
 */
export function resolveLiveNode(element: LiveElementLike, options: ResolveLiveNodeOptions): LiveNodeMatch | null {
  const stamped = nearestStampedAncestor(element)
  if (!stamped) return null

  const candidates = options.index.get(stamped.stampId)
  if (!candidates || candidates.length === 0) return null

  const occurrences = options.occurrencesOf(stamped.stampId)
  const position = occurrences.indexOf(stamped.element)
  const inRange = position >= 0 && position < candidates.length
  const nodeId = inRange ? candidates[position]! : candidates[0]!

  // Exact requires BOTH: the element the caller asked about is the one that
  // actually carried the stamp (not an ancestor stepped up to), AND the
  // occurrence/tree-order pairing found a real candidate at that position.
  return { nodeId, exact: stamped.element === element && inRange }
}

function nearestStampedAncestor(element: LiveElementLike): { element: LiveElementLike; stampId: string } | undefined {
  let current: LiveElementLike | null = element
  while (current) {
    const stampId = current.getAttribute(STUDIO_NODE_ID_ATTR)
    if (stampId) return { element: current, stampId }
    current = current.parentElement
  }
  return undefined
}
