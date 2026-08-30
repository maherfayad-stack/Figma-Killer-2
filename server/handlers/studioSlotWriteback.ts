/**
 * studioSlotWriteback — the studio edit kinds for the "page-as-component with
 * slots" flagship (`STUDIO-FIGMA-PARITY-PLAN.md` §8, Track E): `insert-slot`
 * (`insertJsxIntoSlotProp`, E2.4), `promote-component`
 * (`extractSubtreeToComponent`, E2.1/E2.4), and `add-slot-prop`
 * (`addSlotPropToComponent`, E2.2). Their schemas and their dispatch into
 * `@core/ast-codemods`, in one place.
 *
 * Split out of `studioWriteback.ts` for the same reason `studioCssWriteback.ts`
 * and `studioStructuralWriteback.ts` were: a genuinely different shape of
 * write gets a genuinely different module. `studioWriteback.ts` owns VALUE
 * edits (rewrite one attribute/literal in place); `studioStructuralWriteback.ts`
 * owns the three gestures that relocate/remove/create a CHILD. These three are
 * none of that: `insert-slot` writes into a component PROP, not a child list
 * or an existing attribute's scalar value; `promote-component` mints a whole
 * new FILE (like `extractComponentCopy`'s dedicated route, unlike
 * `detach`/`swap`, which rewrite an existing element in place); `add-slot-prop`
 * rewrites an EXISTING component's own signature and one piece of its inline
 * markup, with a real preview/commit split (see `AddSlotPropEditSchema`'s own
 * doc) none of its siblings need. All three are one-shot, reload-afterwards
 * commits when they actually write — `shifted` is unconditionally `true` for
 * a committed one, the same posture `move`/`delete`/`insert`/`detach`/`swap`
 * already take; `add-slot-prop`'s `preview: true` case never writes at all
 * (see `isSlotPreviewOutcome`'s own doc for why `applied` is asked per-outcome
 * rather than assumed true for every ok result, unlike its two siblings).
 *
 * The dependency runs ONE WAY, identical to the structural/CSS siblings:
 * `studioWriteback.ts` decodes and path-guards the target (and, for
 * `insert-slot`'s optional anchor, a second location), calls `applySlotEdit`,
 * and translates a refusal into `StudioEditRefusalError`; this module imports
 * nothing back and returns a plain refusal object.
 *
 * WHY `promote-component`/`add-slot-prop` STAY SERVER-SIDE-STATELESS.
 * `studioWriteback.ts`'s dispatcher has no access to the currently loaded
 * page tree — it never has, for any kind (`detach`/`swap` are the same
 * shape: no `lockReason` reaches them either). `extractSubtreeToComponent`
 * therefore gets the ORIGINAL, un-split `nodeId` (so its own `refusePlacement`
 * call still catches `shared-component` from the `~` separator and `list-row`
 * from a `#N` suffix or its own AST-only `.map`-callback safety net) but no
 * `lockReason`, so a parser-recorded structural lock with no id-encodable
 * signal (a spread bearer, a dynamic branch) will not refuse `code-placed`
 * here. This is not a new gap: it is the SAME gap `detach`/`swap` already
 * have, and the same answer applies — the gate that matters runs
 * client-side, against the loaded tree, before the edit is ever constructed
 * (`refusePlacement`/`refuseStructuralEdit`, asked by the store), exactly as
 * `struct-01` established for `move`/`delete`/`insert`. See
 * `extractSubtreeToComponent.ts`'s own module doc, "LOCATE, THEN REFUSE
 * FIRST", for the full breakdown of which reasons are AST-derivable with no
 * caller-supplied state. `add-slot-prop`'s target is the JSX child BECOMING
 * the slot (never the component's own root, never a call site elsewhere on
 * the board) — the client-side pre-check E2.5 needs is
 * `refuseStructuralEdit({ kind: 'delete', node: targetChildNode })` asked
 * against THAT node, reusing `list-row`/`shared-component`/`route-chrome`/
 * `code-placed` for the identical reason a real delete would refuse: the
 * target's own markup is being removed from this component's inline render.
 * `no-jsx-parent`/`unsupported-params`/`unsupported-props-type`/
 * `prop-name-taken` stay codemod-only refusals — `refuseStructuralEdit` has
 * no vocabulary for them, the same way `deleteJsxElement`'s own
 * `orphans-import`/`no-jsx-parent` stay AST-only residuals in `struct-01`.
 */
import { insertJsxIntoSlotProp, extractSubtreeToComponent, addSlotPropToComponent, type ComponentCallSite } from '@core/ast-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One element written into a slot's value — identical recursive shape to
 * `studioStructuralWriteback.ts`'s `InsertNodeSchema` (`insertJsxElement`'s
 * own `InsertJsxNode`), because `insertJsxIntoSlotProp` renders a subtree the
 * exact same way `insertJsxElement` does — see that codemod's own doc for why
 * they share the renderer instead of two parallel implementations.
 */
const SlotJsxNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    name: Type.String(),
    importSpecifier: Type.Optional(Type.String()),
    props: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
    children: Type.Optional(Type.Union([Type.String(), Type.Array(Self)])),
  }),
)

/**
 * One "fill this component's slot prop" writeback (E2.4) —
 * `insertJsxIntoSlotProp`. `nodeId` is the CALL SITE element's own location
 * (a `studio.instance` node's own id, never composite — the same convention
 * `callSiteProps:<name>` prop edits already use), because the slot being
 * filled is one of ITS attributes, not a node that exists on the canvas yet.
 *
 * `propName` is either a real slot name (`'header'`) or the literal string
 * `'children'`, which routes this whole edit through `insertJsxElement`
 * instead — see `insertJsxIntoSlotProp`'s own doc for why the default slot is
 * not an attribute at all. `anchorNodeId`/`position` are consulted ONLY in
 * that `children` case.
 */
const InsertSlotEditSchema = Type.Object({
  kind: Type.Literal('insert-slot'),
  nodeId: Type.String(),
  propName: Type.String(),
  node: SlotJsxNodeSchema,
  /** `'replace'` swaps the slot's current JSX value for `node` instead of adding alongside it — see `insertJsxIntoSlotProp`'s `mode`. Omitted means `'append'`. */
  mode: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('replace')])),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
})

/**
 * One "pull this subtree out into its own component" writeback (E2.1/E2.4) —
 * `extractSubtreeToComponent`. `nodeId` is the subtree ROOT's own studio node
 * id — composite when it is an inlined instance's own markup, `#N`-suffixed
 * when it is a `.map` row, passed through UN-SPLIT (never `target.rel`) so
 * `refusePlacement` still sees the `~`/`#` that names those two refusals.
 *
 * `componentName` is the caller's choice (the picker UI's job to validate as
 * PascalCase before sending), never invented by this codemod — unlike
 * `extractComponentCopy`'s auto-incrementing `Card2`/`Card3`, so the caller
 * already knows the resulting file (`<pageDir>/<componentName>.tsx`) before
 * this call returns.  `existingComponentNames` is an optional pass-through to
 * the SAME field on `extractSubtreeToComponent` — when the caller already has
 * Track E1's `GET /admin/api/studio/components` catalog, passing its names
 * here gets the strongest `name-taken` check; omitted, the codemod falls back
 * to its own lighter existence-only workspace scan.
 *
 * `slotChildren` (E2.2) is the promote-time keep/slot toggle, passed straight
 * through to `extractSubtreeToComponent`'s own field of the same name — see
 * that module's doc for the full model. Omitted/empty means every direct
 * child stays inline, byte-identical to a promote with no slots at all.
 */
const SlotChildDecisionSchema = Type.Object({
  childIndex: Type.Number(),
  slotName: Type.String(),
})

const PromoteComponentEditSchema = Type.Object({
  kind: Type.Literal('promote-component'),
  nodeId: Type.String(),
  componentName: Type.String(),
  existingComponentNames: Type.Optional(Type.Array(Type.String())),
  slotChildren: Type.Optional(Type.Array(SlotChildDecisionSchema)),
})

/**
 * One "add a slot prop to an EXISTING component" writeback (E2.2) —
 * `addSlotPropToComponent`. `nodeId` is the target JSX CHILD's own location —
 * the piece of the component's own inline markup becoming `{slotName}` — a
 * plain `rel:line:col` inside the COMPONENT's own file, never a call site
 * elsewhere on the board. Unlike `promote-component`, which always rewrites
 * the ONE call site it just created, this kind never rewrites any call site
 * at all — `callSites` (below) is purely informational, the blast radius,
 * not a write target.
 *
 * `exportName` is `LocalComponentSpec.exportName` (Track E1's catalog,
 * `'default'` or a named export) — which function in the file to edit, the
 * same field `addSlotPropToComponent.ts`'s own params use directly.
 *
 * **`preview` is not decoration — it is the enforced "blast radius up
 * front" mechanism** (`addSlotPropToComponent.ts`'s own doc, "THE BLAST
 * RADIUS, ENFORCED, NOT JUST DOCUMENTED"). The intended two-call sequence:
 *   1. Client submits `{ ..., preview: true }`. The codemod runs its FULL
 *      validation and mutation pipeline in memory, computes the live
 *      `callSites`, and never calls `saveSync()` — `applied: false`,
 *      `addSlotPropDetail.committed: false` on the outcome, so
 *      `applyStudioEditBatch` does NOT count it as written OR skipped (see
 *      that function's own loop) and no file on disk changes.
 *   2. Client shows `callSites` to the user, then (only on confirmation)
 *      resubmits the IDENTICAL edit with `preview` omitted. Because step 1
 *      already proved every non-callSite refusal would not fire, this
 *      second call either commits or refuses for the SAME reason step 1
 *      would have (nothing about the target changed between the two calls
 *      in the ordinary case) — never a surprise the user hasn't already
 *      seen the shape of.
 */
const AddSlotPropEditSchema = Type.Object({
  kind: Type.Literal('add-slot-prop'),
  nodeId: Type.String(),
  exportName: Type.String(),
  slotName: Type.String(),
  preview: Type.Optional(Type.Boolean()),
})

/** The three slot/promote edit kinds, folded into `StudioEditSchema` by `studioEditSchemas.ts`. */
export const SlotEditSchemas = [InsertSlotEditSchema, PromoteComponentEditSchema, AddSlotPropEditSchema] as const

export const SlotEditSchema = Type.Union([...SlotEditSchemas])
export type SlotEdit = Static<typeof SlotEditSchema>

/** The slot/promote edit kinds, for the caller's `kind`-based branching. */
export function isSlotEditKind(kind: string): kind is SlotEdit['kind'] {
  return kind === 'insert-slot' || kind === 'promote-component' || kind === 'add-slot-prop'
}

/**
 * True when `outcome` is a genuine `add-slot-prop` PREVIEW — `ok: true`,
 * nothing written, not a failure. `applyStudioEditBatch`'s counting loop
 * (`studioWriteback.ts`) asks this so it doesn't fold a deliberate,
 * read-only probe into either `written` or `skipped`/`unexplainedSkips` —
 * both would misreport what actually happened. Defined here, next to
 * `StudioAddSlotPropDetail.committed` itself, rather than re-derived at the
 * call site.
 */
export function isSlotPreviewOutcome(outcome: { applied: boolean; addSlotPropDetail?: StudioAddSlotPropDetail }): boolean {
  return outcome.addSlotPropDetail !== undefined && !outcome.addSlotPropDetail.committed
}

/**
 * What changed when a `promote-component` edit succeeds — the same
 * "caller-facing detail beyond ok/refused" shape `swapDetails` already
 * established, surfaced through `StudioEditBatchResult.promoteDetails`.
 * `freeVariables` is `extractSubtreeToComponent`'s full inferred prop
 * partition, returned so a caller offering a review step (rename a prop, fix
 * a mis-inferred `ComponentType`) has something to show — this codemod does
 * not itself pause for review (see `extractSubtreeToComponent.ts`'s own doc).
 * `slots` (E2.2) is the same codemod's own `slots` field, verbatim — every
 * slot the promote actually created, empty when `slotChildren` was
 * omitted/empty.
 */
export interface StudioPromoteComponentDetail {
  newFile: string
  componentName: string
  freeVariables: { name: string; kind: string; isComponentTag: boolean }[]
  slots: { slotName: string }[]
}

/**
 * What an `add-slot-prop` edit produced — EITHER a preview OR a commit, both
 * shapes carried through here (see `AddSlotPropEditSchema`'s own doc).
 * `callSites` is `findComponentCallSites`'s live answer at the moment this
 * ran; `committed` is `false` for a `preview: true` call (nothing reached
 * disk) and `true` for an ordinary one.
 */
export interface StudioAddSlotPropDetail {
  slotName: string
  callSites: ComponentCallSite[]
  committed: boolean
}

/** A decoded, already path-guarded source location. */
interface JsxLocation {
  file: string
  line: number
  col: number
}

/**
 * Applied, or refused with a reason the caller turns into a
 * `StudioEditRefusalError`. `applied` is explicit (not assumed `true`)
 * because `add-slot-prop`'s `preview: true` case is a genuine `ok: true`
 * outcome that did NOT write anything — `studioWriteback.ts`'s
 * `StudioEditApplyOutcome.applied` reads straight from this field so its own
 * batch counters (`written`/`skipped`) can tell a preview apart from both a
 * real write and an unexplained skip.
 */
export type SlotEditOutcome =
  | { ok: true; applied: boolean; promoteDetail?: StudioPromoteComponentDetail; addSlotPropDetail?: StudioAddSlotPropDetail }
  | { ok: false; reason: string; message: string }

/**
 * Run one slot/promote edit's codemod.
 *
 * `anchor`/`workspaceRoot` mirror `applyStructuralEdit`'s own parameters:
 * `anchor` is the caller's already-decoded, same-file `anchorNodeId` (only
 * meaningful for `insert-slot`'s `children` delegation), and `workspaceRoot`
 * is the project root both `insertJsxIntoSlotProp`'s import-writing and
 * `extractSubtreeToComponent`'s new-file placement need.
 */
export function applySlotEdit(
  loc: JsxLocation,
  edit: SlotEdit,
  anchor: { line: number; col: number } | null,
  workspaceRoot: string,
): SlotEditOutcome {
  switch (edit.kind) {
    case 'insert-slot': {
      const result = insertJsxIntoSlotProp({
        ...loc,
        propName: edit.propName,
        node: {
          name: edit.node.name,
          ...(edit.node.importSpecifier === undefined ? {} : { importSpecifier: edit.node.importSpecifier }),
          ...(edit.node.props === undefined ? {} : { props: edit.node.props }),
          ...(edit.node.children === undefined ? {} : { children: edit.node.children }),
        },
        ...(edit.mode === undefined ? {} : { mode: edit.mode }),
        ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
      })
      return result.ok ? { ok: true, applied: true } : { ok: false, ...result.refusal }
    }
    case 'promote-component': {
      const result = extractSubtreeToComponent({
        ...loc,
        workspaceRoot,
        componentName: edit.componentName,
        nodeId: edit.nodeId,
        ...(edit.existingComponentNames ? { existingComponentNames: new Set(edit.existingComponentNames) } : {}),
        ...(edit.slotChildren ? { slotChildren: edit.slotChildren } : {}),
      })
      if (!result.ok) return { ok: false, ...result.refusal }
      return {
        ok: true,
        applied: true,
        promoteDetail: {
          newFile: result.newFile,
          componentName: result.componentName,
          freeVariables: result.freeVariables,
          slots: result.slots,
        },
      }
    }
    case 'add-slot-prop': {
      const result = addSlotPropToComponent({
        ...loc,
        workspaceRoot,
        exportName: edit.exportName,
        slotName: edit.slotName,
        ...(edit.preview ? { preview: true } : {}),
      })
      if (!result.ok) return { ok: false, ...result.refusal }
      return {
        ok: true,
        applied: result.committed,
        addSlotPropDetail: { slotName: result.slotName, callSites: result.callSites, committed: result.committed },
      }
    }
  }
}
