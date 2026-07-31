/**
 * The grammar of a STUDIO-IMPORTED node id, and the one question every writeback
 * path asks of it: is there a single source location an edit to this node could
 * land on?
 *
 * Node ids are page-tree's vocabulary, so the grammar of the ones the studio
 * importer mints lives here rather than in the importer. Three shapes:
 *
 *   `src/screens/Home.jsx:65:16`            a plain element — writable
 *   `pages/Home.jsx:77:19~components/Icon.jsx:3:6`
 *                                           inlined out of a local component:
 *                                           writable, at the component's file,
 *                                           which means every instance of it
 *   `src/screens/Home.jsx:70:21#2`          iteration 2 of a `.map` — NOT
 *                                           writable: one piece of source JSX
 *                                           produced N nodes, and there is no
 *                                           position an edit to row 2 could
 *                                           occupy that would not rewrite all
 *                                           of them
 *
 * A CMS node id (a nanoid) matches none of these and is not source-derived at
 * all — callers must not treat it as unwritable, only as "not our business".
 *
 * This module exists because the rule was mirrored in three regexes (the parser,
 * the client save adapter, the server save route) with nothing keeping them in
 * agreement, and they disagree in exactly the direction that corrupts a file:
 * a greedy `(.*):(\d+):(\d+)` run against a composite id yields a real line and
 * column paired with a file path that does not exist.
 */

/** Separator between a call site and the component node inlined into it (§2.4). */
export const INLINE_ID_SEPARATOR = '~'

/** Separator between a node's source location and its `.map` iteration index. */
export const LOOP_ID_SEPARATOR = '#'

/** `<rel>:<line>:<col>` — anchored, so an iteration suffix cannot match. */
const SOURCE_LOCATION = /^(.*):(\d+):(\d+)$/

/**
 * `<rel>:<line>:<col>` followed by any number of `.map` iteration suffixes
 * (nested loops append one per level — see `parsePageFile`'s `idSuffix`).
 * Deliberately WIDER than `SOURCE_LOCATION`: this asks "did the studio
 * importer mint this id?", not "can an edit land on it".
 */
const SOURCE_DERIVED_ID = /^(.+):(\d+):(\d+)(#\d+)*$/

/** `layout`/`template` at any App Router segment depth. */
const ROUTE_CHROME_FILE = /^(layout|template)\.(tsx|ts|jsx|js)$/i

/** A decoded studio source location: workspace-relative file plus 1-based line/column. */
export interface SourceNodeLocation {
  rel: string
  line: number
  col: number
}

/**
 * The source location a node id writes back to, or `null` when it has none —
 * a synthetic node (the `index:body` root), a `.map` iteration, or a CMS nanoid.
 *
 * Splitting on `INLINE_ID_SEPARATOR` FIRST is not optional: for a composite id
 * the target is the LAST segment, which is genuinely where the markup lives.
 * Without the split, the greedy `(.*)` matches straight through the separator
 * and reports the file as `"pages/Home.jsx:77:19~components/Icon.jsx"`.
 *
 * Callers that write files must still apply their own path policy to `rel` —
 * this is a grammar, not a permission check. See `isWritableSourceRel` in
 * `server/handlers/studioWriteback.ts`.
 */
export function decodeSourceNodeId(nodeId: string): SourceNodeLocation | null {
  const target = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  const match = SOURCE_LOCATION.exec(target)
  if (!match) return null
  return { rel: match[1]!, line: Number(match[2]), col: Number(match[3]) }
}

/**
 * True when an edit to this node has one source location to land on.
 *
 * `false` for a `.map` iteration (`…:70:21#2`) — the suffix is deliberately
 * chosen so the location regex cannot match it — and for anything that is not a
 * source-derived id at all.
 */
export function hasWritableSourceLocation(nodeId: string): boolean {
  return decodeSourceNodeId(nodeId) !== null
}

/** True when this id came from a component inlined at a call site — one edit here rewrites every instance. */
export function isInlinedNodeId(nodeId: string): boolean {
  return nodeId.includes(INLINE_ID_SEPARATOR)
}

/**
 * True when the studio importer minted this id at all — a source location,
 * with or without `.map` iteration suffixes, with or without a call-site
 * prefix. `false` for a CMS node (a nanoid, which has no `:`) and for the
 * synthetic page root.
 *
 * The complement of `hasWritableSourceLocation`, not a weaker version of it:
 * an id can be source-derived and still have nowhere honest to write (a
 * `.map` row). Guards that must distinguish "not our business" from "ours,
 * and refused" need BOTH questions, which is why they are two functions.
 */
export function isSourceDerivedNodeId(nodeId: string): boolean {
  const target = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  return SOURCE_DERIVED_ID.test(target)
}

/**
 * True for the synthetic root `parsedPageToSitePage` mints for every imported
 * page (`<pageId>:body`). It is not a source location — nothing was written at
 * it — so a structural edit whose only target is this node has nowhere to go,
 * and callers need to be able to say so on an EMPTY imported page, where no
 * child id is available to answer the question instead.
 *
 * A CMS page's root is a nanoid and never matches.
 */
export function isStudioPageRootId(rootNodeId: string): boolean {
  return rootNodeId.endsWith(':body') && !isSourceDerivedNodeId(rootNodeId)
}

/**
 * True when this node lives in a Next.js App Router `layout.tsx`/`template.tsx`
 * — one file composed into EVERY route beneath it, so one board frame's edit
 * silently rewrites markup every other frame is also showing.
 *
 * Unlike an inlined component, those nodes keep a plain `relFile:line:col` id
 * (there is exactly one composed position per route, so there is nothing to
 * disambiguate), which means `isInlinedNodeId` does not catch them.
 *
 * Matched on the filename alone, deliberately: a non-Next project that happens
 * to have a `layout.tsx` is then treated as shared too. That direction is the
 * safe one — the cost of a false positive is a refusal the user can work
 * around, the cost of a false negative is a frame they cannot see is stale.
 */
export function isRouteChromeNodeId(nodeId: string): boolean {
  const location = decodeSourceNodeId(nodeId)
  if (!location) return false
  const basename = location.rel.split(/[/\\]/).pop() ?? ''
  return ROUTE_CHROME_FILE.test(basename)
}
