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
import { AtRuleScopeSchema, CssEditSchema } from './studioCssWriteback'
import {
  SlotEditSchemas,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail,
} from './studioSlotWriteback'
import { StructuralEditSchemas } from './studioStructuralWriteback'
import { CanvasLayerEditSchemas, type CanvasLayerRemovedText } from './studioCanvasLayerWriteback'
import { UndoJournalTokenSchema } from './studio/undoJournalToken'
import type { CreatedJsxLocation } from '@core/ast-codemods'
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

/**
 * One `style={{ ... }}` merge writeback — `setJsxStyle`.
 *
 * `remove` (`style-03`) names camelCase properties to DELETE. Without it a
 * cleared inline style reached no code path at all: the diff sent changed keys
 * only and the codemod merged, so the declaration stayed on disk and came back
 * on the next reload.
 */
const StyleEditSchema = Type.Object({
  kind: Type.Literal('style'),
  nodeId: Type.String(),
  style: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
  remove: Type.Optional(Type.Array(Type.String())),
})

/**
 * One `className` token add/remove writeback (Track B2) — `setJsxClassName`.
 * Replaces Phase 0 item 0.6's honesty-only stopgap: a `node.classIds` change
 * now reaches disk here instead of only ever warning that it couldn't.
 *
 * `add`/`remove` carry TOKENS, never `StyleRule` ids — the ids are Studio's own
 * `sc-<hash>` bookkeeping. Two token shapes, because two kinds of class exist
 * in a real repo (`style-02`):
 *
 *   - `{ kind: 'literal', token }` — a class whose NAME is what the DOM
 *     carries: a plain `.css` rule, a Tailwind utility, a generated framework
 *     class. Written as a plain token in the `className` attribute.
 *   - `{ kind: 'module', file, local }` — a class declared in a CSS Module.
 *     Its DOM name is a bundler-computed hash, so writing any literal name for
 *     it produces markup that styles nothing outside the tool that computed
 *     that hash. `file` is the workspace-relative `*.module.css` path (guarded
 *     by `studioWriteback.ts`'s `resolveClassNameTokens` before it is ever
 *     turned into a specifier) and `local` is the class as WRITTEN in that file, so the
 *     codemod can emit the only reachable spelling: `styles.<local>`.
 *
 * Can REFUSE with a specific reason (`css-module-binding` /
 * `template-dynamic` / `spread-attribute` / `unsupported-call` /
 * `unsupported-expression` — `ClassNameRefusalReason` in `@core/ast-codemods`)
 * exactly like `detach`/`swap`/`css` do — see `applyStudioEdit`'s `'class'`
 * case. Since P3-C (WB-18) an ADD to an expression `className` wraps it rather
 * than refusing, and a module token whose stylesheet the file does not import
 * yet is imported after the batch (`cssModuleImportPlan.ts`), so through this
 * schema `css-module-import-missing` no longer occurs.
 */
const ClassNameTokenSchema = Type.Union([
  Type.Object({ kind: Type.Literal('literal'), token: Type.String() }),
  Type.Object({ kind: Type.Literal('module'), file: Type.String(), local: Type.String() }),
])

/** One class token on the wire — `literal` or `module`. See `ClassEditSchema`. */
export type StudioClassNameToken = Static<typeof ClassNameTokenSchema>

const ClassEditSchema = Type.Object({
  kind: Type.Literal('class'),
  nodeId: Type.String(),
  add: Type.Array(ClassNameTokenSchema),
  remove: Type.Array(ClassNameTokenSchema),
})

/**
 * W4-4 Phase B — one declaration VALUE rewritten inside a
 * `styled-components`/emotion tagged template (`setStyledDeclaration`,
 * `@core/ast-codemods`).
 *
 * ## Why this lives here and not beside `CssEditSchema`
 *
 * `studioCssWriteback.ts` is its own module because a `kind: 'css'` edit is
 * the one shape that shares nothing with its siblings: its target is a FILE +
 * SELECTOR resolved at load time, it decodes no `nodeId`, and postcss — not
 * ts-morph — does the writing. A styled edit is the opposite on every count.
 * Its target IS a `rel:line:col` (the `styled.…` tag's own position), so it
 * rides `studioEditLocation`'s path guard, `studioEditFile`'s touched-file
 * collection, and `orderStudioEditsForApply`'s bottom-up ordering with no
 * special case at all — the same deal `prop`/`text`/`style`/`literal` get. A
 * sibling handler module would have had to re-derive all three.
 *
 * `className` is the synthetic class Phase A flattened this template's CSS
 * under; `selector` is the flattened selector the declaration lives beneath
 * (`.Card_sc__a1b2c3`, `.Card_sc__a1b2c3:hover`); `atRule`, when present, is
 * the nested `@media`/`@container`/`@supports` block it sits in, as
 * `name params` (P3-C, WB-31). Together they name exactly one declaration in one
 * template — the codemod refuses, by name, if they name zero or two.
 *
 * There is no `op` here, and that is the scope statement: a styled edit only
 * ever SETS an existing declaration's value. Adding a declaration, removing
 * one, or renaming a property means restructuring a template the user wrote,
 * which this pass refuses client-side before an edit is ever built.
 */
const StyledEditSchema = Type.Object({
  kind: Type.Literal('styled'),
  nodeId: Type.String(),
  className: Type.String(),
  selector: Type.String(),
  atRule: Type.Optional(AtRuleScopeSchema),
  property: Type.String(),
  value: Type.String(),
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

/**
 * P3-F — put back what a journaled one-shot write (`delete`/`detach`/`swap`/
 * `promote-component`) changed, by the token its batch reported
 * (`StudioEditBatchResult.undoToken`). The files are the server's own record
 * (`studio/undoJournal.ts`); the client never sends file text. Applies only
 * when every file is still exactly what that write left, else refuses
 * `restore-stale`. Editor-only and alone in its batch
 * (`studioBatchUndoJournal.ts`).
 *
 * `nodeId` addresses nothing: it is the key a refusal is reported under, by
 * convention `undo-journal:<token>`, and never decodes to a location.
 */
const RestoreEditSchema = Type.Object({
  kind: Type.Literal('restore'),
  nodeId: Type.String(),
  token: UndoJournalTokenSchema,
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
export const StudioEditSchema = Type.Union([
  PropEditSchema,
  TextEditSchema,
  StyleEditSchema,
  ClassEditSchema,
  StyledEditSchema,
  LiteralEditSchema,
  TagEditSchema,
  AssetEditSchema,
  DetachEditSchema,
  SwapEditSchema,
  RestoreEditSchema,
  ...StructuralEditSchemas,
  ...SlotEditSchemas,
  // P5-G — the free canvas's five kinds (`studioCanvasLayerWriteback.ts`).
  ...CanvasLayerEditSchemas,
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
/** Why an `applied: false` outcome had nowhere to write — see {@link StudioEditApplyOutcome.unwritable}. */
export type StudioEditUnwritableReason = 'no-source-location' | 'stylesheet-unavailable' | 'asset-unavailable'

export interface StudioEditApplyOutcome {
  applied: boolean
  /**
   * WB-12 — for an `applied: false` outcome that is not an `add-slot-prop`
   * preview: WHY there was nowhere to write. The batch reports it as the
   * refusal of that name (`studioEditRefusals.ts`); absent reads as
   * `no-source-location`.
   */
  unwritable?: StudioEditUnwritableReason
  swapDetail?: StudioEditSwapDetail
  createdStylesheet?: { file: string }
  promoteDetail?: StudioPromoteComponentDetail
  addSlotPropDetail?: StudioAddSlotPropDetail
  /**
   * `store-13` — the tag-name `line:col` of every element this edit brought
   * into existence (`insert`/`duplicate`/`wrap`/`group`), in source order,
   * measured against the file as it stands the moment that edit finished. A
   * LIST because one `insert` can write a run of siblings (P5-B IMG-2: three
   * dropped images are one edit). Absent for every kind that creates nothing,
   * and EMPTY when the codemod wrote but could not confirm the positions. A
   * LOCATION, not a node id: minting the id needs the workspace-relative path
   * and the batch's final line count, and both are `applyStudioEditBatch`'s
   * to know — see `StudioEditBatchResult.createdNodeIds`.
   */
  created?: readonly CreatedJsxLocation[]
  /**
   * Which node id's FILE `created` is measured against, when that is not this
   * edit's own. Only `transplant` (D2 G3) sets it: the element it creates
   * lands in the DESTINATION's file, so minting the id off `edit.nodeId` — the
   * origin — would name a position in the file the markup just LEFT.
   */
  createdIn?: string
  /**
   * `store-14` — the tag-name `line:col` of every element this edit MOVED,
   * measured the same way `created` is. A relocation creates nothing, so it
   * has no `created`; but `move`/`reparent`/`ungroup` are exactly the kinds
   * whose node ids change, which is why the board used to lose its selection
   * across one and why their own undo has nothing to address without this.
   * An `ungroup` reports several — its children all move at once.
   */
  relocated?: readonly CreatedJsxLocation[]
  /**
   * Which node id's FILE `relocated` is measured against, when that is not
   * this edit's own. Only `transplant` sets it, for `createdIn`'s reason: a
   * MOVE across frames lands in the destination's file.
   */
  relocatedIn?: string
  /**
   * P5-G — populated only for a successful `canvas-layer-delete`: the layer
   * module's own bytes, which its undo writes back (`canvas-layer-restore`).
   */
  removed?: CanvasLayerRemovedText
}

/**
 * One edit that did not write — surfaced to the client with its SPECIFIC
 * reason and a sentence for the person who made it.
 *
 * WB-12 — every kind refuses by name (`studioEditRefusals.ts`): a codemod's
 * typed decline, P1-A's `element-moved`, an `applied: false` outcome with its
 * `unwritable` reason, and `write-failed` for an exception nobody named. So the
 * batch's `refusals` list is COMPLETE: an edit the caller sent wrote exactly
 * when no refusal matches its `(nodeId, kind, prop)`. That is the per-edit
 * outcome the client commits its diff baselines against (WB-35).
 *
 * `nodeId` is the id the caller SENT, even for an edit that was re-found
 * elsewhere (P1-D) or merged with another instance's (WB-7, reported once per
 * contributing node). `prop` is present for a `prop` edit only: one element
 * can carry several prop edits in a batch, and only the refused one may be
 * held back.
 */
export interface StudioEditRefusal {
  nodeId: string
  kind: StudioEdit['kind']
  prop?: string
  reason: string
  message: string
}

/**
 * P5-G — how a batch is run. `canvasLayers: 'allow'` is passed by the editor's
 * `/save` route alone; absent (every agent tool), canvas-layer kinds and
 * layer-module targets are refused by name (`studioCanvasLayerWriteback.ts`).
 */
export interface StudioEditBatchOptions {
  canvasLayers?: 'allow'
  /**
   * P3-F — record a journaled one-shot write's pre-image and report its
   * `undoToken`, and accept a `restore`. The editor's `/save` route alone sets
   * it (`studioBatchUndoJournal.ts`).
   */
  journal?: true
}

/** The result of applying a batch of studio edits — `POST /admin/api/studio/save`'s own response shape. */
export interface StudioEditBatchResult {
  written: number
  skipped: number
  /** True when any write shifted a touched file's line count — stale `line:col` node ids downstream must re-parse. */
  shifted: boolean
  /** True when any edit targets an inlined/shared source location — every OTHER frame reading the same file is now stale too. */
  sharedComponents: boolean
  /**
   * Every edit that did not write, with why — the complete per-edit outcome
   * (see {@link StudioEditRefusal}). `skipped === refusals.length`. Empty array
   * when every edit wrote (always present, never omitted).
   */
  refusals: StudioEditRefusal[]
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
  /**
   * `store-13` — the node id of every element this batch CREATED
   * (`insert`/`duplicate`/`wrap`/`group`), in the order the batch wrote them.
   * The plain `rel:line:col` shape the parser will mint for the same element
   * on the next read, so the editor can select what a structural gesture just
   * made once the board has re-synced (`keys-01`'s K7 follow-up: until this
   * existed, ⌘D on a source-backed project left the ORIGINAL selected, because
   * the copy had no id the client could name).
   *
   * Empty when nothing was created, and an edit whose position could not be
   * confirmed against the re-parsed file contributes nothing rather than a
   * guess — a wrong id would select, and then let the user edit, an element
   * they never made.
   */
  createdNodeIds: string[]
  /**
   * `store-14` — the node id every element this batch MOVED now has
   * (`move`/`reparent`/`ungroup`, and a `transplant` that moved rather than
   * copied), in the order the batch wrote them, in the same plain
   * `rel:line:col` shape as `createdNodeIds`.
   *
   * The counterpart `store-13` left open: a relocation creates nothing, so it
   * reports no `createdNodeIds`, and until this existed the board dropped its
   * selection every time a drag reordered or reparented an element — the moved
   * node's own id had changed and nothing said what it became. It is also what
   * the family's undo addresses: the inverse of an ungroup is a group around
   * the children it released, and the inverse of a cross-frame move is a
   * transplant of the element back.
   *
   * Empty when nothing moved; an edit whose new position could not be
   * confirmed against the re-parsed file contributes nothing rather than a
   * guess, exactly as `createdNodeIds` does.
   */
  relocatedNodeIds: string[]
  /**
   * P5-G — every `canvas-layer-delete` in the batch that SUCCEEDED, with the
   * module bytes it removed, keyed by the edit's own `nodeId`. Empty when the
   * batch removed no layer.
   */
  removed: (CanvasLayerRemovedText & { nodeId: string })[]
  /**
   * P1-A — every VALUE edit that landed (`prop`/`text`/`style`/`class`/`tag`/
   * `literal`/`asset`), with its target's identity as it stands after the
   * write, keyed by the edit's own `nodeId`. A value write changes the very
   * bytes the fingerprint covers without moving the target, and the board does
   * not re-read a file for a write that shifted nothing, so this is how the
   * client's recorded identity stays current — without it, Studio's own
   * previous write would make the next edit to the same element refuse
   * `element-moved`. See `studioEditIdentity.ts`.
   */
  fingerprints: { nodeId: string; fingerprint: string }[]
  /**
   * P1-D — every node id an edit named that was RE-FOUND elsewhere in its
   * file, because the file changed on disk since the caller read it: the id
   * it sent, and the id it was written at. Every other field reports under
   * the id the caller sent; this is the one place the new address appears.
   * Non-empty implies `shifted`. See `studioEditRelocate.ts`.
   */
  retargeted: { nodeId: string; to: string }[]
  /**
   * P3-F — the undo-journal token for this batch's journaled one-shot write
   * (`delete`/`detach`/`swap`/`promote-component`): what a `restore` edit
   * names to put every file it changed back. Present only for a
   * `journal: true` batch that wrote one and could record it
   * (`studio/undoJournal.ts` says when it cannot).
   */
  undoToken?: string
}
