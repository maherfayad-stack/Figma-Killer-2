/**
 * studioEditSchemas — the WIRE SHAPE of a studio edit, BOTH DIRECTIONS: the
 * request union (the nine "value kind" TypeBox schemas — `prop` / `text` /
 * `style` / `class` / `literal` / `tag` / `asset` / `detach` / `swap` — plus
 * `StudioEditSchema`, folding in the three sibling groups owned elsewhere)
 * AND, below it, the `POST /admin/api/studio/save` RESPONSE shape
 * (`StudioEditBatchResult` and everything it's built from). Both halves are
 * "what crosses the wire", the same reason `PropEditSchema` and
 * `StudioEditBatchResult` belong in one module even though one is a TypeBox
 * schema and the other is a plain interface — the DISCRIMINATOR is direction
 * (client→server / server→client), not shape:
 *
 *   - `css` (`kind: 'css'`, `studioCssWriteback.ts`) — a `set` or `insert`
 *     declaration write.
 *   - `move` / `delete` / `insert` (`studioStructuralWriteback.ts`).
 *   - `insert-slot` / `promote-component` / `add-slot-prop`
 *     (`studioSlotWriteback.ts`, E2.4/E2.2) — the "page-as-component with
 *     slots" flagship's writeback: filling a component's slot PROP, pulling
 *     a subtree out into its own file, and adding a slot prop to one that
 *     already exists.
 *
 * Split out of `studioWriteback.ts` (`module-size-budgets`'s 700-line
 * ceiling) to separate two genuinely different reasons to change: the WIRE
 * SHAPE (this module — add a field, a new discriminated kind, change what a
 * successful/refused edit reports) from the DISPATCH BEHAVIOUR
 * (`studioWriteback.ts` — decode a `rel:line:col`, call the matching
 * codemod, order/dedupe/batch a save, fold each outcome into the running
 * counters this module's own `StudioEditBatchResult` describes).
 * `studioWriteback.ts` re-exports `StudioEditSchema`/`StudioEdit` verbatim,
 * so every existing consumer's import path (`from './studioWriteback'` /
 * `from '../studioWriteback'`) is unchanged — and imports every RESULT type
 * below back the same way.
 *
 * The result types were moved here (not left in `studioWriteback.ts`) at the
 * point `add-slot-prop` needed to add a field to nearly every one of them
 * (`StudioEditApplyOutcome`, `StudioEditRefusal['kind']`,
 * `StudioEditBatchResult`) and `studioWriteback.ts` had 8 lines of headroom
 * left. Not a line-count trick — a genuine "these belong with the other
 * wire-shape definitions" move, consistent with this module's own stated
 * split (wire shape here, dispatch behaviour there).
 */
import { CssEditSchema } from './studioCssWriteback'
import {
  isSlotEditKind,
  SlotEditSchemas,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail,
} from './studioSlotWriteback'
import { isStructuralEditKind, StructuralEditSchemas } from './studioStructuralWriteback'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One prop attribute writeback — `setJsxProp`.
 *
 * WS-4.2/4.3 — `prop` may arrive prefixed `callSiteProps:<name>` (the
 * convention `parsedPageToSitePage.ts` uses for a `studio.instance`'s
 * call-site props, parallel to `style:<property>`). `applyStudioEdit` strips
 * the prefix before calling `setJsxProp` — a `studio.instance`'s own id IS
 * the call site's plain (non-composite) location, so the prop write lands
 * on the call site's own JSX attribute exactly like any other node's.
 */
const PropEditSchema = Type.Object({
  kind: Type.Literal('prop'),
  nodeId: Type.String(),
  prop: Type.String(),
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
})

/** One element-text-children writeback — `setJsxText`. */
const TextEditSchema = Type.Object({
  kind: Type.Literal('text'),
  nodeId: Type.String(),
  text: Type.String(),
})

/** One `style={{ ... }}` merge writeback — `setJsxStyle`. */
const StyleEditSchema = Type.Object({
  kind: Type.Literal('style'),
  nodeId: Type.String(),
  style: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
})

/**
 * One `className` token add/remove writeback (Track B2) — `setJsxClassName`.
 * Replaces Phase 0 item 0.6's honesty-only stopgap: a `node.classIds` change
 * now reaches disk here instead of only ever warning that it couldn't.
 *
 * `add`/`remove` carry class NAMES (`site.styleRules[id].name`), never ids —
 * the ids are Studio's own `sc-<hash>` bookkeeping, and the codemod edits the
 * literal token text in the user's `className` attribute. Can REFUSE with a
 * specific reason (`css-module-binding` / `template-dynamic` / `spread-
 * attribute` / `unsupported-call` / `unsupported-expression` —
 * `ClassNameRefusalReason` in `@core/ast-codemods`) exactly like `detach`/
 * `swap`/`css` do — see `applyStudioEdit`'s `'class'` case.
 */
const ClassEditSchema = Type.Object({
  kind: Type.Literal('class'),
  nodeId: Type.String(),
  add: Type.Array(Type.String()),
  remove: Type.Array(Type.String()),
})

/**
 * One string-literal-in-place writeback — `setStringLiteral`.
 *
 * The odd one out: its target is not the JSX the node renders, but the literal
 * that JSX READS. `<span>{c.hotelsTag}</span>` cannot be written at the span —
 * that would replace the i18n binding with a baked string — while
 * `hotelsTag: 'Exclusive rates on hotels'` in `translations.js` is an ordinary
 * literal and rewriting it is exactly what editing that copy means. The client
 * emits this from `PageNode.textOrigin`.
 *
 * `nodeId` here is the ORIGIN's own `rel:line:col`, not the rendering node's, so
 * ordering / dedupe / touched-file collection all keep working through the one
 * `studioEditLocation` decoder — and two board nodes fed by the same dictionary
 * key dedupe onto one write, which is what shared copy means.
 */
const LiteralEditSchema = Type.Object({
  kind: Type.Literal('literal'),
  nodeId: Type.String(),
  text: Type.String(),
})

/**
 * One element rename — `setJsxTagName`.
 *
 * `tag` is the one editor property that is not an attribute: it is synthesized
 * from the element's NAME so an imported `<h1>` keeps rendering as an `<h1>`.
 * Writing it through `setJsxProp` added a literal `tag="section"` attribute and
 * left the element a `<div>`, so it gets its own kind and its own codemod.
 */
const TagEditSchema = Type.Object({
  kind: Type.Literal('tag'),
  nodeId: Type.String(),
  tag: Type.String(),
})

/**
 * One import-specifier writeback — `setImportSpecifier` (WS-8.3).
 *
 * The other odd one out, same shape of oddity as `literal` above: its target
 * is not the JSX the node renders (`<img src={heroImg}/>`), but the IMPORT
 * DECLARATION that JSX reads through. `nodeId` here is `PageNode.assetOrigin`'s
 * own `rel:line:col` — the import's module-specifier literal — so it decodes
 * through the same `studioEditLocation` every other edit kind shares.
 *
 * `assetPath` is the workspace-relative POSIX path of the file the import
 * should point at AFTER the edit (from `POST /admin/api/studio/asset-upload`'s
 * response, or an existing asset the picker offered) — never a specifier
 * string directly: computing the actual relative specifier from the
 * IMPORTING file's own directory to `assetPath` is `applyStudioEdit`'s job,
 * because only the server knows both paths precisely, and doing it here means
 * `assetPath` gets the same containment guard every other write target gets
 * (see `resolveContainedAssetPath`) before a single character reaches disk.
 */
const AssetEditSchema = Type.Object({
  kind: Type.Literal('asset'),
  nodeId: Type.String(),
  assetPath: Type.String(),
})

/**
 * One "detach a local component instance" writeback (WS-4.4) —
 * `detachComponentInstance`. `nodeId` is a `studio.instance` node's own id
 * (the call site's plain location — never composite, see that node's doc
 * comment). Unlike every other edit kind, this can REFUSE with a specific
 * reason rather than simply "no writable location" — see `applyStudioEdit`'s
 * `StudioEditRefusalError`.
 */
const DetachEditSchema = Type.Object({
  kind: Type.Literal('detach'),
  nodeId: Type.String(),
})

/**
 * One "swap this instance for a different component" writeback (WS-4.5) —
 * `swapComponentInstance`. `newComponentFile` is a workspace-relative POSIX
 * path when `newComponentSource` is `'local'`, or a bare package specifier
 * when `'package'`.
 */
const SwapEditSchema = Type.Object({
  kind: Type.Literal('swap'),
  nodeId: Type.String(),
  newComponentName: Type.String(),
  newComponentSource: Type.Union([Type.Literal('local'), Type.Literal('package')]),
  newComponentFile: Type.String(),
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
export const StudioEditSchema = Type.Union([
  PropEditSchema,
  TextEditSchema,
  StyleEditSchema,
  ClassEditSchema,
  LiteralEditSchema,
  TagEditSchema,
  AssetEditSchema,
  DetachEditSchema,
  SwapEditSchema,
  ...StructuralEditSchemas,
  ...SlotEditSchemas,
  CssEditSchema,
])
export type StudioEdit = Static<typeof StudioEditSchema>

// ---------------------------------------------------------------------------
// The RESPONSE half of the wire shape — `POST /admin/api/studio/save`'s own
// return value, and the per-edit outcome `studioWriteback.ts`'s dispatcher
// folds into it. See this module's own doc for why these live here.
// ---------------------------------------------------------------------------

/**
 * WS-4.5 — what changed on the call site's props when a `swap` edit
 * succeeds: attributes the new component doesn't accept (dropped) and
 * required props it needs that the call site didn't already supply (left
 * for the user to fill in — never synthesized). Surfaced all the way to the
 * client (`StudioEditBatchResult.swapDetails` → `/save`'s response →
 * `swapComponentInstance` in `fsCodemodAdapter.ts`) so the Properties panel
 * can report it instead of a bare "swapped" toast.
 */
export interface StudioEditSwapDetail {
  removedProps: string[]
  unfilledRequiredProps: string[]
}

/**
 * `applyStudioEdit`'s result. `applied: false` means "nothing reached disk"
 * — for most kinds that's "no writable source location, nothing to do" (a
 * synthetic node, an unresolvable asset target), the existing `skipped`
 * counter's meaning; for `add-slot-prop` specifically it can ALSO mean a
 * deliberate `preview: true` probe that ran its full validation and
 * mutation pipeline in memory and simply never saved — see
 * `addSlotPropDetail.committed`, which is what tells
 * `applyStudioEditBatch`'s loop the two apart (a preview must NOT be
 * counted as skipped). `swapDetail` is populated only for a successful
 * `swap` edit — see `StudioEditSwapDetail`. `createdStylesheet` is
 * populated only for a successful `css`/`create` edit (Track B1) — the
 * workspace-relative path the server actually invented, so the client can
 * show the user which destination was chosen and make the rule writable on
 * its next edit without a reload — see `studioCssWriteback.ts`'s
 * `CssEditOutcome` doc. `promoteDetail` is populated only for a successful
 * `promote-component` edit (E2.4) — see `StudioPromoteComponentDetail`.
 * `addSlotPropDetail` (E2.2) is populated for EVERY `add-slot-prop` outcome,
 * preview or commit — see `StudioAddSlotPropDetail`.
 */
export interface StudioEditApplyOutcome {
  applied: boolean
  swapDetail?: StudioEditSwapDetail
  createdStylesheet?: { file: string }
  promoteDetail?: StudioPromoteComponentDetail
  addSlotPropDetail?: StudioAddSlotPropDetail
}

/**
 * One `detach`/`swap`/`move`/`delete`/`css`/slot edit that refused rather
 * than writing — surfaced to the client so it can show the SPECIFIC reason
 * (a toast with an offer, per WS-4.4's plan; `StyleTargetChip`'s per-tier
 * message for `css`; the AST-only structural reasons for `move`/`delete`)
 * instead of a generic "skipped" count.
 */
export interface StudioEditRefusal {
  nodeId: string
  kind: 'detach' | 'swap' | 'move' | 'delete' | 'insert' | 'css' | 'class' | 'insert-slot' | 'promote-component' | 'add-slot-prop'
  reason: string
  message: string
}

/** The edit kinds whose refusal is a NAMED, expected outcome rather than a codemod exception. */
export function isRefusingEditKind(kind: StudioEdit['kind']): kind is StudioEditRefusal['kind'] {
  return kind === 'detach' || kind === 'swap' || kind === 'css' || kind === 'class' || isStructuralEditKind(kind) || isSlotEditKind(kind)
}

/**
 * `STUDIO-FIGMA-PARITY-PLAN.md` item 0.7 — one edit that skipped WITHOUT a
 * named `StudioEditRefusal` (no writable source location for a `prop`/`text`/
 * `style`/etc, or an unexpected codemod exception on a non-refusing kind).
 * Distinct from `StudioEditRefusal`: this case has no specific reason to
 * report — `applyStudioEdit` returned `applied: false` because there was
 * simply nowhere to write, not because a codemod evaluated the edit and
 * declined it. The client previously only received an aggregate `skipped`
 * count for this bucket (`fsCodemodAdapter.ts`'s `unexplainedSkips` toast),
 * which could never say WHICH node(s) were affected. This carries just
 * enough for the client to resolve and select the affected node(s) — it
 * already has the full `PageNode` tree, so a bare id is enough; no reason
 * string to keep here since (per the point of this type) there isn't one.
 */
export interface StudioEditUnexplainedSkip {
  nodeId: string
  kind: StudioEdit['kind']
}

/** The result of applying a batch of studio edits — `POST /admin/api/studio/save`'s own response shape. */
export interface StudioEditBatchResult {
  written: number
  skipped: number
  /** True when any write shifted a touched file's line count — stale `line:col` node ids downstream must re-parse. */
  shifted: boolean
  /** True when any edit targets an inlined/shared source location — every OTHER frame reading the same file is now stale too. */
  sharedComponents: boolean
  /** WS-4.4/4.5 — every `detach`/`swap` edit that refused, with why. Empty array when none did (always present, never omitted, so a client doesn't need an `?.length` guard). */
  refusals: StudioEditRefusal[]
  /**
   * Item 0.7 — every edit that skipped with NO matching `refusals` entry,
   * i.e. exactly the set `fsCodemodAdapter.ts`'s `unexplainedSkips` count
   * describes today, but named. `unexplainedSkips.length` always equals
   * `skipped - refusals.length`, so a client can drop the old subtraction
   * once it reads this instead.
   */
  unexplainedSkips: StudioEditUnexplainedSkip[]
  /** WS-4.5 — every `swap` edit that SUCCEEDED, with what changed on the call site. Empty array when none did. */
  swapDetails: (StudioEditSwapDetail & { nodeId: string })[]
  /**
   * Track B1 — every `css`/`create` edit that SUCCEEDED, with the
   * workspace-relative stylesheet path the server actually invented.
   * `nodeId` is the edit's own synthetic id (`css:create:<ruleId>` —
   * `styleRuleWriteback.ts`'s `ruleIdFromCssCreateNodeId` decodes it back to
   * a `StyleRule.id`), the same join-key convention `swapDetails` uses.
   * Empty array when none did — this is how a created file stops being
   * silent: the client shows the user WHICH stylesheet was made, and
   * records the mapping so the rule is writable through the ordinary `set`
   * path on its very next edit, with no reload.
   */
  createdStylesheets: { nodeId: string; file: string }[]
  /**
   * E2.4 — every `promote-component` edit that SUCCEEDED, with the new
   * file/component name it minted and the free-variable partition it
   * inferred (`StudioPromoteComponentDetail`). `nodeId` is the edit's own
   * (subtree root) id, the same join-key convention `swapDetails` uses.
   * Empty array when none did.
   */
  promoteDetails: (StudioPromoteComponentDetail & { nodeId: string })[]
  /**
   * E2.2 — every `add-slot-prop` edit that ran, preview OR commit, with the
   * blast radius it computed (`StudioAddSlotPropDetail`). A preview and its
   * later confirming commit both produce an entry here — the client tells
   * them apart by `committed`. `nodeId` is the edit's own (target JSX
   * child's) id, the same join-key convention `swapDetails` uses. Empty
   * array when none did.
   */
  addSlotPropDetails: (StudioAddSlotPropDetail & { nodeId: string })[]
  /**
   * mcp-tooling (WS-9's live-reload bridge) — every ABSOLUTE file path any
   * edit in the batch decoded a location in, whether or not that edit
   * ultimately wrote (a `css`/`set`/`insert` edit's synthetic nodeId never
   * decodes here — see `studioEditFile` — so those alone report none; a
   * `css`/`create` edit is the one exception, since it also rewrites the
   * PAGE's own import list — see `applyStudioEditBatch`'s own comment).
   * Not "written" in the applied-count sense: `studio_apply_edits`'s caller
   * maps this to page ids for a best-effort live-reload push, and
   * re-reading a page whose edit happened to refuse is a harmless no-op,
   * not a bug.
   */
  touchedFiles: string[]
}
