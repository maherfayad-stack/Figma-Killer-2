/**
 * studioEditRouting — WHICH file a writeback edit lands in, and in what
 * ORDER a batch of them is applied.
 *
 * Split out of `studioWriteback.ts` when that file passed the 700-line
 * ceiling. The seam is the one its callers already use: four modules
 * outside the writeback path (`editTools.ts`, `extractComponent.ts`,
 * `nodeJsxSource.ts`, `reloadScope.ts`) import only this half — "decode this
 * node id, is that file writable" — and never apply an edit.
 *
 * Not to be confused with its neighbour `studioEditTargets.ts`, which
 * guards the paths an edit REFERS to (an asset, a CSS module) rather than
 * the one it WRITES.
 *
 * Everything here is pure: a node id in, a location / a boolean / a
 * reordered array out. Nothing reads or writes a file, which is why the
 * composite-id and ordering rules can be tested without a fixture project.
 *
 * `studioWriteback.ts` re-exports all of it, so every existing import keeps
 * working and the writeback path still has one front door.
 */
import { join } from 'node:path'
import { INLINE_ID_SEPARATOR, realWorkspaceRel, unwritableWorkspaceSegment } from '@core/page-parser'
import { isInlinedNodeId, isRouteChromeNodeId } from '@core/page-tree'
import { CANVAS_LAYER_REL_PATTERN } from '@core/studio-board'
import { collapseSameTargetEdits, type DedupedStudioEdit } from './studioEditMerge'
import { isSlotEditKind } from './studioSlotWriteback'
import { isStructuralEditKind } from './studioStructuralWriteback'
import { isCanvasLayerEditKind } from './studioCanvasLayerWriteback'
import type { StudioEdit } from './studioEditSchemas'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/


/** A decoded writeback target: workspace-relative file plus 1-based line/column. */
export interface StudioEditLocation {
  rel: string
  line: number
  col: number
}

/**
 * The GRAMMAR half of decoding a node id: split the composite id, match
 * `rel:line:col`, apply the lexical path guard. Private, because a `rel` that
 * has only been through this is not yet a write target — see
 * {@link studioEditLocation}, which is the only exported way to get one.
 *
 * Splitting on `INLINE_ID_SEPARATOR` FIRST is not optional. `NODE_LOC_ID`'s
 * greedy `.*` matches straight through the separator, so running it on a whole
 * composite id yields the right line/col with a file path of
 * `"pages/Home.jsx:77:19~components/Icon.jsx"` — a path that does not exist,
 * and if it ever did, a file the user never asked to modify.
 */
function decodeNodeIdLocation(nodeId: string): StudioEditLocation | null {
  const target = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  const m = NODE_LOC_ID.exec(target)
  if (!m) return null
  const rel = m[1]!
  return isWritableSourceRel(rel) ? { rel, line: Number(m[2]), col: Number(m[3]) } : null
}

/**
 * The source location a node id writes back to inside `dir`, or `null` for a
 * synthetic node (e.g. the `index:body` root) that has none, a path the
 * lexical guard refuses, or a path that resolves outside the project.
 *
 * For a COMPOSITE (inlined) id — `callSite~component:line:col`, §2.4 — the
 * target is the LAST segment: the component's own file and position. That is
 * genuinely where the markup lives, so it is genuinely where an edit belongs.
 *
 * ## Why this takes `dir`, and why the `rel` it returns is not the one it read
 *
 * `sec-17` landmine 4: the guard used to be purely lexical, which means it had
 * no opinion about two `rel`s that name ONE file. Two spellings do —
 * `pages/Home.tsx` vs `pages/home.tsx` on a case-insensitive filesystem (this
 * machine, every Windows install, default macOS), and `mirror/Home.tsx` where
 * `mirror` is a symlink or an NTFS junction to `pages` (the kind git stores,
 * so an imported repo carries it). The consequence was not theoretical:
 * `transplantJsxElement`'s same-file guard compared the two strings, so a
 * cross-frame move between two aliases of one file wrote the destination, then
 * clobbered it with the origin's text minus the moved element — the markup
 * gone, inserted nowhere, and `{ ok: true }` reported. `sec-17` fixed that ONE
 * codemod by realpath-comparing its two ends; this closes the property itself,
 * so nothing downstream has to remember.
 *
 * So the decode canonicalises: it resolves the real path of `join(dir, rel)`
 * and re-derives `rel` from the real path of `dir`. Two aliases therefore
 * produce the SAME `rel`, which is what makes `dedupeStudioEdits`' key, the
 * batch's touched-file set, and every codemod's `join(dir, rel)` agree about
 * how many files a batch touches.
 *
 * It also turns the lexical guard into a real containment check. A `.tsx`
 * symlink INSIDE the project pointing outside it passed the old guard (no
 * `..`, not absolute, right extension) and was written; now `relative()`
 * reports a `..` segment and the decode refuses. The same re-check is what
 * refuses a link spelled like source whose real path is inside `.studio/`,
 * `.git/` or any other directory {@link isWritableSourceRel} refuses (P1-G).
 *
 * A file that does not exist yet canonicalises through its deepest existing
 * ancestor (so a symlinked project root, or macOS' `/var` → `/private/var`,
 * cannot put `dir` and the file on different sides of a link); a path through
 * a DANGLING link is refused, because a write would follow it.
 */
export function studioEditLocation(dir: string, nodeId: string): StudioEditLocation | null {
  const decoded = decodeNodeIdLocation(nodeId)
  if (!decoded) return null
  const rel = canonicalSourceRel(dir, decoded.rel)
  return rel === null ? null : { rel, line: decoded.line, col: decoded.col }
}

/**
 * `rel` as the filesystem actually spells it, relative to `dir` — or `null`
 * when it is not a writable source path inside `dir`. See
 * {@link studioEditLocation} for why this exists; exported so the few callers
 * that hold a `rel` rather than a node id (`reloadScope.ts`'s round-tripped
 * `files` list) can apply the same rule instead of a parallel one.
 */
export function canonicalSourceRel(dir: string, rel: string): string | null {
  if (!isWritableSourceRel(rel)) return null

  // `realWorkspaceRel` (`@core/page-parser`'s shared write scope) resolves
  // symlinks and junctions through the deepest ancestor that exists, so a
  // file this batch is about to create still canonicalises; restores the
  // on-disk casing; and answers `null` for a path that escapes `dir` or runs
  // through a dangling link (which a write would follow).
  const canonical = realWorkspaceRel(dir, join(dir, ...rel.split(/[/\\]+/)))
  // Re-run the lexical guard on the RESULT: a symlink spelled like source
  // that really lands in `.studio/` comes back as a `.studio/…` rel, and the
  // directory check refuses it.
  return canonical !== null && isWritableSourceRel(canonical) ? canonical : null
}

/** Files a writeback may touch. Never a `.env`, a lockfile, or anything else that isn't app source. */
const WRITABLE_SOURCE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs)$/i

/**
 * Whether a decoded `rel` is safe to write, checked on the PATH SHAPE alone so
 * this stays pure and every consumer of `studioEditLocation` inherits it.
 *
 * The whole batch arrives from the client, `rel` included, and the save route
 * builds its target with `join(dir, rel)` — so `../../.ssh/config:1:1` as a
 * nodeId was an arbitrary file write. Nothing legitimate produces one: the parser
 * mints these ids from `path.relative(workspaceRoot, file)` for files it already
 * found inside the workspace.
 *
 * The extension check is the second half. Even contained, a writeback belongs on
 * app source and nowhere else, and every codemod here parses its target as
 * TypeScript/JavaScript anyway.
 *
 * The directory check is the third (P1-G). Every directory Studio owns or that
 * is not the user's source — `.studio` (the trust tier, MCP approvals), `.claude`
 * (the agent's own hook settings), `.git` (executable by proxy), `node_modules`,
 * build output — is refused through the ONE predicate every Studio writer
 * shares, `unwritableWorkspaceSegment` (`@core/page-parser`). Before it,
 * `.studio/anything.tsx:1:1` was a valid target for every edit kind.
 * `canonicalSourceRel` re-runs this whole guard on the REAL path.
 *
 * Exported (not just used internally) so `studio/reloadScope.ts` (Track C5)
 * can apply the SAME adversarial-path guard to the `files` list a reload-scope
 * request round-trips back to the server, rather than a second, parallel
 * check that could drift from this one.
 */
export function isWritableSourceRel(rel: string): boolean {
  if (rel.length === 0) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false
  const segments = rel.split(/[/\\]/)
  if (segments.some((segment) => segment === '..' || segment === '')) return false
  if (unwritableWorkspaceSegment(rel) !== null && !isStudioAuthoredSourceRel(rel)) return false
  return WRITABLE_SOURCE_EXTENSION.test(rel)
}

/**
 * Source files Studio itself authors INSIDE an otherwise unwritable directory:
 * the one extension point in {@link isWritableSourceRel}'s directory check.
 *
 * It holds exactly one pattern (FC-1, P5-G, under security-guard review): the
 * free canvas's layer modules, `.studio/canvas/<id>.tsx`
 * (`docs/audits/2026-09-23-studio-audit/10-free-canvas.md`). The pattern is
 * `@core/studio-board`'s `CANVAS_LAYER_REL_PATTERN` — anchored at both ends,
 * forward slashes only, lowercase only, one fixed id grammar (`cl` + ten
 * base-36 characters) — so it admits no traversal, no nesting, no other
 * extension and no case or separator variant of the same file. Every other
 * `.studio` path stays refused: `.studio/meta.tsx`, `.studio/canvas/x/y.tsx`,
 * `.STUDIO/canvas/<id>.tsx` and a backslash spelling all fail it.
 *
 * It widens this node-id decoder only. `canonicalSourceRel` still re-runs the
 * guard on the REAL path, so a `.studio/canvas` that is a link elsewhere is
 * judged by where it really lands. The agent's native writes
 * (`agentWriteScope.ts`), CSS writeback and asset landing never consult it,
 * and a batch run for an agent refuses every canvas-layer target
 * (`studioCanvasLayerWriteback.ts`'s `refuseAgentCanvasLayerEdit`). Nothing
 * else belongs in this list without its own security review.
 */
const STUDIO_AUTHORED_SOURCE_PATTERNS: readonly RegExp[] = [CANVAS_LAYER_REL_PATTERN]

function isStudioAuthoredSourceRel(rel: string): boolean {
  return STUDIO_AUTHORED_SOURCE_PATTERNS.some((pattern) => pattern.test(rel))
}

/**
 * True when an edit to this node invalidates OTHER frames on the board —
 * because the id is an inlined component instance, because it belongs to
 * route chrome composed into many routes, or (WS-8.3) because it is an ASSET
 * edit. The save route returns this as `sharedComponents` so the client knows
 * to reload rather than trust its in-memory copy of the other frames.
 *
 * `isInlinedNodeId`/`isRouteChromeNodeId` are the page-tree module's own id
 * grammar (`@core/page-tree/sourceNodeId.ts`) — the same predicates the
 * editor's structural refusal consults, so the "this write is shared" answer
 * cannot drift between the two sides of the wire.
 *
 * An asset edit's target is an IMPORT DECLARATION, which any number of JSX
 * usages in the same file can read (`<img src={hero}/>` appearing twice) —
 * unlike a plain prop/style/tag edit, whose `nodeId` names the ONE element
 * being changed, there is no cheap way to
 * tell from the id alone whether another node depends on the same import.
 * Treated as shared unconditionally: same "fail toward the reload" policy as
 * route chrome below — the cost of a false positive is one redundant reload,
 * the cost of a false negative is a board showing an image that no longer
 * matches source.
 *
 * WB-2 — a `literal` edit is shared too. Its target is a dictionary entry
 * or a module-scope const (`textOrigin`), and a dictionary key is shared BY
 * DESIGN: every other node — on this page or any other — that resolves to the
 * same literal still shows the old copy until something re-reads it. The
 * resync that follows is narrow: `reloadScope.ts` asks which routes recorded
 * the origin file among their dependencies (the evaluator reports every file
 * it reads a value out of — `pageParseCache.ts`), and reloads exactly those.
 *
 * WS-4.4/4.5 — `detach`/`swap` are ALSO treated as shared unconditionally:
 * both always rewrite JSX structure (adding/removing imports, replacing an
 * element) and therefore always shift line numbers, invalidating every OTHER
 * node id below them in the same file whether or not this particular node
 * happened to be an inlined/shared one.
 *
 * `struct-01` — `move`/`delete` join them for the same reason: relocating or
 * removing a JSX child always changes the line count of every node id below it.
 *
 * E2.4/E2.2 — `insert-slot`/`promote-component`/`add-slot-prop` join them too:
 * filling a slot with a multi-line subtree, pulling one out into its own
 * file, and rewriting an existing component's own signature all change a
 * touched file's line count exactly like the structural three — WHEN they
 * write. A `preview: true` `add-slot-prop` writes nothing, but this function
 * only sees `kind`, not the edit's own `preview` flag, so it still reports
 * `true` for one; `applyStudioEditBatch`'s `written`-gated reload (see
 * `docs/features/studio-import.md`'s "A save only reloads when a write
 * actually landed") is what keeps a preview-only batch from reloading
 * anything despite this.
 */
export function isSharedSourceNodeId(nodeId: string, kind?: StudioEdit['kind']): boolean {
  if (kind === 'asset' || kind === 'literal' || kind === 'detach' || kind === 'swap') return true
  // P5-G — every canvas-layer kind creates, removes or moves a whole element
  // across files, exactly like `transplant`.
  if (kind !== undefined && (isStructuralEditKind(kind) || isSlotEditKind(kind) || isCanvasLayerEditKind(kind))) return true
  return isInlinedNodeId(nodeId) || isRouteChromeNodeId(nodeId)
}

/**
 * Order a save batch BOTTOM-TO-TOP: descending line, then descending column.
 * Node ids encode a `line:col` source location, and a codemod can change a
 * file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line). Applying the lowest positions first guarantees an edit can
 * never invalidate the source location of another edit still pending in the
 * same batch — and because the sort is descending by line globally, it is also
 * descending within each file, so a batch spanning several files stays safe.
 * Edits whose id has no decodable location sort last — `applyStudioEdit`
 * no-ops on them anyway. Pure, so the ordering is unit-testable without
 * touching the filesystem.
 *
 * This is the one place that uses the GRAMMAR decode rather than
 * `studioEditLocation`, and deliberately: ordering is about line numbers, and
 * the sort is descending by line globally (therefore also within each file),
 * so which file a `rel` names never enters the comparison. Canonicalising here
 * would buy nothing and would cost an O(n log n) burst of `realpath` calls on
 * the save path.
 */
export function orderStudioEditsForApply<T extends { nodeId: string }>(edits: readonly T[]): T[] {
  return [...edits].sort((a, b) => {
    const la = decodeNodeIdLocation(a.nodeId)
    const lb = decodeNodeIdLocation(b.nodeId)
    if (!la) return 1
    if (!lb) return -1
    return lb.line - la.line || lb.col - la.col
  })
}

/**
 * Collapses edits that resolve to the SAME source location into one.
 *
 * Two board nodes can share one writeback target: every instance of an inlined
 * component maps back to the same lines in that component's file (measured on
 * the eSIM corpus: 138 of 223 targets are shared, one of them by 29 nodes).
 * Without this, editing two instances in a single batch would apply both writes
 * to the same position — the second reading a file the first already changed,
 * for a silent last-write-wins with a stale intermediate.
 *
 * WB-7 — collapsing is not always "keep the last". A `style` or `class` edit
 * carries a SET of changes, and two instances' sets are both wanted, so they
 * are MERGED; only a genuine conflict (one property, one token, one prop value)
 * is last-wins. The node ids that collapsed ride along on the surviving edit as
 * `absorbedNodeIds`, so its outcome is reported for every one of them. See
 * `studioEditMerge.ts`.
 *
 * `dir` is here so the key is the CANONICAL `rel` (`studioEditLocation`):
 * before `sec-18` this keyed on the raw string, so `pages/Home.tsx:10:5` and
 * `pages/home.tsx:10:5` — one file on this filesystem — were two keys and both
 * writes landed, which is precisely the stale-intermediate failure this
 * function exists to prevent.
 *
 * ## Why `insert` and `insert-slot` are exempt
 *
 * Every other kind OVERWRITES the span its nodeId points at, so two of them on
 * one location are the same write twice and last-one-wins is the honest
 * reading. `insert` does not overwrite anything: its nodeId names the
 * CONTAINER, and the edit ADDS a child to it. Two inserts against one container
 * are therefore two different, both-wanted elements, not a duplicate — and
 * collapsing them silently dropped all but the last, so composing a screen one
 * batch at a time quietly produced a single child no matter how many were
 * asked for, with `written` reporting the truth and nothing reporting the loss.
 *
 * `insert-slot` (E2.4) is the identical shape one level down: its `nodeId`
 * names the CALL SITE, not one attribute — filling `header` AND `footer` on
 * the same call site in one batch is two different, both-wanted slots, not a
 * duplicate. The dedup key below only distinguishes by the field name `prop`
 * (`PropEditSchema`'s own field, not `insert-slot`'s `propName`), so without
 * this exemption two DIFFERENT slot fills on one call site would collapse to
 * whichever the batch listed first.
 *
 * `duplicate` and `wrap` (W4-1) are exempt for the same reason as `insert`:
 * neither overwrites the span its nodeId points at, both ADD around it. Two
 * duplicates of one element in a batch are two copies the user asked for
 * (`⌘D ⌘D`), and two wraps are two nested containers — collapsing either to one
 * would silently drop work while `written` reported the truth. `group` (K3)
 * joins them: two groups keyed on the same first element are two nested
 * containers around two different runs. `ungroup` does NOT — it removes the
 * span its nodeId points at, so a second one in the same batch is the same
 * write twice.
 *
 * `transplant` (D2 G3) is exempt too. In its `copy` form it is `duplicate`
 * with a destination in another file, so two of them are two copies the user
 * asked for; in its move form no real gesture can issue two against one
 * element in a batch (a cross-frame drag resolves one target, and the second
 * would be planned against a tree the first already changed). Collapsing it
 * would silently drop a copy while `written` reported the truth.
 *
 * `reinsert-source` (`store-15`) joins `insert` for the identical reason: its
 * `nodeId` is the PARENT being restored INTO, not a span it overwrites, and a
 * multi-node delete's ⌘Z posts one `reinsert-source` per restored sibling
 * against that same parent — two wanted elements, not a duplicate write.
 */
export function dedupeStudioEdits<T extends { nodeId: string; kind: string }>(
  dir: string,
  edits: readonly T[],
): DedupedStudioEdit<T>[] {
  const byTarget = new Map<string, DedupedStudioEdit<T>>()
  const passthrough: T[] = []
  for (const edit of edits) {
    const loc = studioEditLocation(dir, edit.nodeId)
    // `styled` (W4-4 Phase B) joins the exemption for the same reason
    // `insert`/`insert-slot` are here: its identity is not the location alone.
    // Every declaration in one template shares that template's `line:col`, so
    // the generic key would collapse `color` and `padding` on one `styled.div`
    // — and a `:hover` override onto its base rule — into whichever the batch
    // listed last. Two styled edits can never be the SAME write either: the
    // client emits at most one per (rule, media, property).
    if (
      !loc ||
      edit.kind === 'insert' ||
      edit.kind === 'insert-slot' ||
      edit.kind === 'duplicate' ||
      edit.kind === 'wrap' ||
      edit.kind === 'group' ||
      edit.kind === 'transplant' ||
      edit.kind === 'reinsert-source' ||
      edit.kind === 'styled' ||
      // P5-G — a place or lift names a real element but is never the "same
      // write" as a value edit on it; the other three carry synthetic ids.
      isCanvasLayerEditKind(edit.kind)
    ) {
      passthrough.push(edit)
      continue
    }
    const prop = 'prop' in edit ? String((edit as { prop?: unknown }).prop) : ''
    const key = `${loc.rel}:${loc.line}:${loc.col}|${edit.kind}|${prop}`
    const earlier = byTarget.get(key)
    byTarget.set(key, earlier ? collapseSameTargetEdits(earlier, edit) : edit)
  }
  return [...byTarget.values(), ...passthrough]
}

/**
 * The absolute file a node id writes back to, or `null` for a synthetic node.
 * Exposed so the save route can build its "which files did this batch touch"
 * set (to detect a codemod-caused line-count shift) without re-deriving the
 * composite-id rule — see `studioEditLocation`, whose canonical `rel` is what
 * makes two aliases of one file a single member of that set.
 */
export function studioEditFile(dir: string, nodeId: string): string | null {
  const loc = studioEditLocation(dir, nodeId)
  return loc ? join(dir, loc.rel) : null
}
