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
 * Mints the plain (non-composite) id for one source position: `rel:line:col`,
 * plus an optional `.map`-iteration suffix (already carrying its own
 * `LOOP_ID_SEPARATOR`, e.g. `#2`). This is the exact string `parsePageFile`
 * builds for every `ParsedNode` — extracted here so a second reader of the
 * SAME source position (the Vite plugin in `@core/studio-runtime`, which has
 * no `.map`/call-site knowledge and therefore never passes `idSuffix`) mints
 * an id that can only ever agree or disagree with the parser's, never drift
 * from it through a hand-copied template string.
 *
 * `line`/`col` are both 1-based — the convention `parsePageFile`'s own header
 * comment states and every caller of this function must already produce.
 */
export function buildSourceNodeId(rel: string, line: number, col: number, idSuffix?: string): string {
  return `${rel}:${line}:${col}${idSuffix ?? ''}`
}

/**
 * The id a Babel-based, single-file stamp can EVER produce for one JSX host
 * element — always the plain `rel:line:col` shape, because a Vite transform
 * sees one file in isolation: it has no call site to prefix (composite ids are
 * minted only once `inlineLocalComponents` splices a component's file into a
 * PAGE's tree) and no loop iteration to suffix (a `.map` runs at runtime; the
 * source has one JSX expression, not N).
 *
 * This is why the live DOM needs `liveNodeResolve` at all: a runtime stamp id
 * is the fixed point both an inlined call site's tail and every row of one
 * expanded `.map` collapse to, and resolving a specific live element back to
 * ITS real tree node id is a positional question this function's callers
 * cannot answer on their own.
 */
export function toRuntimeStampId(rel: string, line: number, col: number): string {
  return buildSourceNodeId(rel, line, col)
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
 * `nodeId` with the location it writes to — the LAST segment, see
 * {@link decodeSourceNodeId} — moved to `line:col` of the same file. A
 * composite id keeps its call-site prefix: only where the markup is has moved.
 * `null` for an id with no writable location.
 *
 * P1-D: an edit re-found after its file changed on disk is re-addressed with
 * this, so every codemod downstream reads the new position through the one
 * grammar.
 */
export function withSourceLocation(nodeId: string, line: number, col: number): string | null {
  const segments = nodeId.split(INLINE_ID_SEPARATOR)
  const location = decodeSourceNodeId(segments[segments.length - 1]!)
  if (!location) return null
  segments[segments.length - 1] = buildSourceNodeId(location.rel, line, col)
  return segments.join(INLINE_ID_SEPARATOR)
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

/**
 * The row TEMPLATE a `.map` row was rendered from — the row id with its
 * iteration suffixes removed (`…:14:9#2` → `…:14:9`, `…:14:9#0#3` → `…:14:9`),
 * keeping any call-site prefix — or `null` when `nodeId` is not a row.
 *
 * The template is one JSX site that renders EVERY row, which is exactly why a
 * row has no writable location of its own. OD-8 (P3-C) makes it the target of
 * a row's STYLE and CLASS edits anyway, on the owner's call — changing every
 * row is what a designer means by restyling a list item, and the editor says
 * so before and after the write. Nothing else may use this to reach a row's
 * source: a row's TEXT and props are per-row values with their own origins,
 * and a structural edit on a row is the array literal's business.
 */
export function loopTemplateNodeId(nodeId: string): string | null {
  const segments = nodeId.split(INLINE_ID_SEPARATOR)
  const tail = segments[segments.length - 1]!
  const match = /^(.+:\d+:\d+)(?:#\d+)+$/.exec(tail)
  if (!match) return null
  segments[segments.length - 1] = match[1]!
  const template = segments.join(INLINE_ID_SEPARATOR)
  return hasWritableSourceLocation(template) ? template : null
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
 * The call site's own `rel:line:col` — the HEAD of a composite id, symmetric
 * to `decodeSourceNodeId`'s tail. For a plain (non-composite) id, that is the
 * whole id, so this returns it unchanged.
 *
 * Why the call site survives a detach/extract when everything else about the
 * node doesn't: R2's retry mechanism (`presentStructuralRefusal`) needs to
 * re-find the node a refused gesture was aimed at, AFTER `detachInstance`/
 * `extractInstanceCopy` triggers a full board reload that re-mints every id
 * derived from the shared component's OWN definition file. The call site's
 * position — where the `<Icon/>` JSX sat in the PAGE — is untouched by either
 * codemod: detaching inlines the definition's markup at that same position,
 * extracting only renames the tag and swaps the import. Neither shifts the
 * opening element's `line:col` in the consuming file (barring a reformat —
 * see `store-10`'s risk note on that).
 */
export function callSitePosition(nodeId: string): string {
  return nodeId.split(INLINE_ID_SEPARATOR)[0]!
}

/**
 * True when `nodeId` is the same call site as `position` — either literally
 * (a plain, non-inlined node) or as the head of a composite id (inlined from
 * that call site). Used to find whatever node NOW occupies a call site whose
 * old id was invalidated by a detach/extract reload.
 */
export function matchesCallSitePosition(nodeId: string, position: string): boolean {
  return nodeId === position || nodeId.startsWith(position + INLINE_ID_SEPARATOR)
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

/**
 * Best-effort location for a `.map`-row id (`…:70:21#2`). `decodeSourceNodeId`
 * deliberately refuses to match this shape at all (`hasWritableSourceLocation`
 * is what that non-match means — see `sourceNodeId.ts`'s own doc), because
 * there is no SINGLE honest writeback target for the row. But there IS a real
 * `rel:line:col` sitting right there in the id — the row's own rendered
 * position, one syntactic hop from the `.map()` call the taxonomy names as
 * the real edit target. Not precise enough to claim as `origin` (this module
 * only sets `origin` when a location is the honest single truth), but precise
 * enough to open the right FILE near the right LINE — the R8 fix for a
 * refusal family the audit otherwise correctly says has no jump-to-source at
 * all today.
 */
export function bestEffortRowLocation(nodeId: string): { rel: string; line: number; col: number } | undefined {
  const target = nodeId.split('~').pop() ?? nodeId
  const match = /^(.+):(\d+):(\d+)(?:#\d+)+$/.exec(target)
  return match ? { rel: match[1]!, line: Number(match[2]), col: Number(match[3]) } : undefined
}
