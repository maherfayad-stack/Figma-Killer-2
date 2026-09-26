/**
 * studioSaveRequests — the `POST /admin/api/studio/save` wire contract, plus
 * every ONE-SHOT edit that commits through it directly instead of waiting for
 * `fsCodemodAdapter`'s autosave diff.
 *
 * Extracted from `fsCodemodAdapter.ts`, which had absorbed the client half of
 * several workstreams at once and was carrying its own size-budget grandfather
 * entry as debt (`STATE.md`'s `debt-01`). The split follows that entry's own
 * named plan — "one module per edit kind, leaving the adapter as the
 * dispatcher its name promises". The adapter still owns load/save-diff; this
 * module owns the request shape and the deliberate, non-debounced commits.
 *
 * Why these live together: each one is a discrete, user-confirmed action
 * (replace this image, detach this instance, swap this component) rather than
 * a value the user is continuously typing, so there is nothing to debounce and
 * no diff to compute — they post a single edit and act on the response. They
 * all need the same two things, which is exactly what this module holds: the
 * response schema and the post-write reporting. Where a write TARGETS lives in
 * `studioWorkspaceDir.ts` (`studioWriteDir`) and what a landed write does to
 * the board in `studioBoardResync.ts` — both were extracted from here once a
 * second caller (`fsCodemodAdapter`'s autosave) needed them too.
 *
 * The STRUCTURAL commits (move/reparent/duplicate/wrap/delete/insert) moved
 * out to `studioStructuralCommits.ts` in W4-1, for the same "a second reason to
 * change" reason: they post a BATCH and share a reload contract of their own —
 * "re-sync with disk, but only when a write actually landed" — which none of
 * the one-shot commits here have. They still post through `postEdits` below.
 */
import type { StyleRule } from '@core/page-tree'
import type { JsonDataValue } from '@core/utils/jsonData'
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { pushToast } from '@ui/components/Toast'
import { studioWriteDir } from './studioWorkspaceDir'
import { captureIdentities, expectationsFor, recordOwnWrites, type IdentityCapture } from './sourceIdentity'
import { structuralEditNodeIds, type StructuralEditPayload } from './structuralUndoPlan'
import { elementMovedNodeIds, retryAfterElementMoved } from './elementMovedRecovery'
import { recordCreatedStylesheet, ruleIdFromCssCreateNodeId } from './styleRuleWriteback'
import { journaledWriteOutcome } from './journaledUndo'

/**
 * P3-F — an undo-journal token as the server mints it
 * (`server/handlers/studio/undoJournalToken.ts`): 32 lowercase hex digits.
 * Mirrored, not imported — the same browser/server wire-shape split every
 * schema here follows.
 */
const UndoTokenSchema = Type.String({ pattern: '^[0-9a-f]{32}$' })

/**
 * POST /admin/api/studio/save response. `shifted` is true when a write changed
 * a file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line) — the in-memory `line:col` node ids are then stale against disk
 * and must be re-derived by re-parsing (see the `shifted` branch in
 * `fsCodemodAdapter`'s `saveSite`).
 */
export const StudioSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  written: Type.Number(),
  skipped: Type.Number(),
  shifted: Type.Boolean(),
  /**
   * True when any edit in the batch targeted an inlined node, whose writeback
   * goes to the component's own file and therefore changes EVERY instance of
   * it. The other instances on the board still show their old values, so the
   * client reloads — same remedy as `shifted`, different cause.
   */
  sharedComponents: Type.Boolean(),
  /**
   * WS-4.4/4.5/6.3 — every `detach`/`swap`/`css` edit in the batch that
   * REFUSED rather than writing, with a specific reason + message
   * (`StudioEditRefusal` on the server). `Type.Optional` (not every server
   * build has this field yet mid-rollout; tolerant like every other response
   * schema here) and defaults to empty when read.
   */
  refusals: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    kind: Type.String(),
    /** WB-35 — present for a `prop` edit: which of the element's props this outcome answers (`editOutcomes.ts`). */
    prop: Type.Optional(Type.String()),
    reason: Type.String(),
    message: Type.String(),
  }))),
  /**
   * instance-ui-01 — every `swap` edit in the batch that SUCCEEDED, with
   * what changed on the call site (mirrors `refusals` for the failure case).
   * `Type.Optional`, same tolerant-rollout reasoning as `refusals` above.
   */
  swapDetails: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    removedProps: Type.Array(Type.String()),
    unfilledRequiredProps: Type.Array(Type.String()),
  }))),
  /**
   * P5-C (DET-5) — every `detach` that did not refuse, written or held back
   * by its `dryRun`: whether it loses other rendered states (`branchNote`),
   * writes a context hook into the enclosing component (`movedHooks`), or
   * changes every `.map` row (`perRow`). `detachInstances` builds its
   * pre-commit confirm from this. `Type.Optional`, same tolerant-rollout
   * reasoning as the fields above.
   */
  detachDetails: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    written: Type.Boolean(),
    lossy: Type.Boolean(),
    branchNote: Type.Optional(Type.String()),
    movedHooks: Type.Array(Type.String()),
    perRow: Type.Boolean(),
  }))),
  /**
   * Track B1 — every `css`/`create` edit in the batch that SUCCEEDED, with
   * the workspace-relative stylesheet path the server actually invented
   * (mirrors `swapDetails` for the "new file" case). `Type.Optional`, same
   * tolerant-rollout reasoning as `refusals`/`swapDetails` above. See
   * `notifyCreatedStylesheets` for how a caller turns this into both the
   * user-visible "which file was created" surfacing and the write-back map
   * update that makes the rule editable on its next edit without a reload.
   */
  createdStylesheets: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    file: Type.String(),
  }))),
  /**
   * Track C5 (reload surgery) — every workspace-ROOT-relative file this
   * batch actually wrote to (`StudioEditBatchResult.touchedFiles`, server-
   * side). `Type.Optional`, same tolerant-rollout reasoning as the fields
   * above. `commitStructural` feeds this straight into `POST
   * /admin/api/studio/reload-scope` to decide whether a targeted per-page
   * reload is safe — see that route's own doc for the full contract. An
   * absent/empty value simply means "nothing to narrow", never an error.
   */
  touchedFiles: Type.Optional(Type.Array(Type.String())),
  /**
   * `store-13` — the node id of every element this batch CREATED
   * (`insert`/`duplicate`/`wrap`/`group`), in the plain `rel:line:col` shape
   * the parser will mint for the same element on its next read. `commitStructural`
   * hands these to `pendingCreatedSelection.ts` so the board can select what the
   * gesture just made once the resync has brought it in — the half `keys-01`'s
   * K7 could not do. `Type.Optional`, same tolerant-rollout reasoning as the
   * fields above; absent simply means "this server build reports none", never
   * an error.
   */
  createdNodeIds: Type.Optional(Type.Array(Type.String())),
  /**
   * `store-14` — the node id every element this batch MOVED now has
   * (`move`/`reparent`/`ungroup`, and a `transplant` that moved rather than
   * copied), in the same plain `rel:line:col` shape as `createdNodeIds`.
   * `commitStructural` selects these alongside the created ones, so a reorder
   * or an ungroup keeps pointing at what the user just moved, and resolves the
   * gesture's own undo against them. `Type.Optional`, same tolerant-rollout
   * reasoning as the fields above.
   */
  relocatedNodeIds: Type.Optional(Type.Array(Type.String())),
  /**
   * OD-8 — where each `list-item` edit's array literal is after the batch
   * (`nodeId` as sent, `to` now): a row delete's import prune can move it,
   * and the board re-addresses its rows there. `Type.Optional`, same
   * tolerant-rollout reasoning as the fields above.
   */
  listArrays: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), to: Type.String() }))),
  /**
   * P5-G — every `canvas-layer-delete` in the batch that SUCCEEDED, with the
   * module bytes it removed, keyed by the edit's own `nodeId` — its ⌘Z
   * (`canvas-layer-restore`) is built from these once the resync lands.
   * `Type.Optional`, same tolerant-rollout reasoning as the fields above.
   */
  removed: Type.Optional(
    Type.Array(Type.Object({ nodeId: Type.String(), text: Type.String(), wholeLine: Type.Boolean() })),
  ),
  /**
   * P3-F — the undo-journal token for a delete/detach/swap/extract batch: the
   * one thing its ⌘Z (`restore`) names. Absent when the server recorded none.
   */
  undoToken: Type.Optional(UndoTokenSchema),
  /**
   * P1-A — each landed value write's target identity AFTER the write, keyed by
   * the edit's own node id. `postEdits` hands it to `sourceIdentity.ts`, so the
   * next write to the same element expects what is on disk now rather than
   * what the board read. `Type.Optional`, same tolerant-rollout reasoning.
   */
  fingerprints: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), fingerprint: Type.String() }))),
})

export type StudioSaveResponse = Static<typeof StudioSaveResponseSchema>

/** The projects already told, this session, that Studio creates stylesheets — see `notifyCreatedStylesheets`. */
const projectsToldAboutCreatedStylesheets = new Set<string>()

/**
 * Track B1's create branch, the user-visible half: turns
 * `StudioSaveResponse.createdStylesheets` into (1) a toast naming the
 * specific file Studio just created and which class it belongs to — "a
 * created file is a bigger surprise than a chosen one, so it must be
 * visible and attributable" — and (2) the `styleRuleWriteback.ts` write-back
 * map update that makes the SAME rule writable through the ordinary `set`
 * path on its very next edit, with no reload. A no-op when the field is
 * absent/empty (an older server build, or a save with no `create` edits).
 *
 * Called once per save response that may carry edits from
 * `collectStyleRuleEdits`: `fsCodemodAdapter.ts`'s `saveSite` invokes it as
 * `notifyCreatedStylesheets(result, site.styleRules)`, right alongside its
 * refusal and `shifted` handling.
 *
 * P3-A — an `info` note, and once per project per session: the first file
 * Studio invents in a project is worth naming, and every later one is the same
 * behaviour the person has already been told about. It used to be a success
 * card on every created file, in the middle of typing a class name.
 *
 * Returns how many stylesheets the response created, so the caller can attach
 * the classes that were waiting on them (ERR-15 — `awaitingCreatedStylesheet`).
 */
export function notifyCreatedStylesheets(
  result: StudioSaveResponse,
  styleRules: Record<string, StyleRule>,
): number {
  const createdList = result.createdStylesheets ?? []
  for (const created of createdList) {
    const ruleId = ruleIdFromCssCreateNodeId(created.nodeId)
    if (!ruleId) continue
    const rule = styleRules[ruleId]
    recordCreatedStylesheet(ruleId, created.file, rule?.selector ?? '')
    const project = studioWriteDir() ?? ''
    if (projectsToldAboutCreatedStylesheets.has(project)) continue
    projectsToldAboutCreatedStylesheets.add(project)
    pushToast({
      kind: 'info',
      title: 'Stylesheet created',
      body: rule
        ? `Studio created ${created.file} for “${rule.name}” and imported it.`
        : `Studio created ${created.file} and imported it.`,
    })
  }
  return createdList.length
}

/**
 * Post one edit to `/save` and return the parsed response. The shared body of
 * every one-shot commit below — each is a single deliberate click, so the
 * moment it posts IS the moment the user acted, and that is when its
 * identities are captured.
 *
 * An `element-moved` refusal (P1-A) is re-planned once against the re-read
 * board (`elementMovedRecovery.ts`) and the retry's answer returned instead;
 * when there is nothing honest to retry against, the ORIGINAL refusal comes
 * back, and the caller's own refusal surface is the one message the user sees.
 */
export async function postOneEdit(edit: StructuralEditPayload): Promise<StudioSaveResponse> {
  const identities = captureIdentities(structuralEditNodeIds(edit))
  const result = await postEdits([edit], identities)
  if (elementMovedNodeIds(result.refusals).size === 0) return result
  return (await retryAfterElementMoved([edit], identities, result.touchedFiles ?? [], postEdits)) ?? result
}

/**
 * How `/save` applies a batch. `sequence` (P3-D): in the order given, each
 * edit against the files the previous ones left, all or nothing — the server's
 * `studioEditSequence.ts`. Without it the edits must be independent, and the
 * route orders them bottom-to-top.
 */
export interface PostEditsOptions {
  sequence?: true
}

/**
 * Post a batch of edits to `/save`. The save route orders them bottom-to-top
 * before applying (unless `options.sequence` asks for them in order).
 *
 * `identities` (P1-A) is what the writer captured about each node id its edits
 * name — sent as `expect`, so an edit whose position now holds a different
 * element refuses `element-moved` instead of writing to it; and it is where the
 * response's post-write identities land (`recordOwnWrites`). Every writer that
 * posts through here — the autosave diff, every structural commit, every
 * one-shot — rides the same guard.
 *
 * `idempotencyKey` is for a caller that retries this one write itself
 * (`studioStructuralCommits.ts`, ERR-6): every attempt shares it, so a replay of
 * a write that landed gets the stored answer instead of a second write.
 */
export async function postEdits(
  edits: readonly Record<string, unknown>[],
  identities?: IdentityCapture,
  idempotencyKey?: string,
  options: PostEditsOptions = {},
): Promise<StudioSaveResponse> {
  const expect = identities ? expectationsFor(identities) : {}
  const result = await apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: {
      dir: studioWriteDir(),
      edits,
      ...(Object.keys(expect).length > 0 ? { expect } : {}),
      ...(options.sequence ? { sequence: true } : {}),
    },
    schema: StudioSaveResponseSchema,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
  recordOwnWrites(identities, result.fingerprints ?? [])
  return result
}

/**
 * instance-ui-01 — the outcome of a single `swap` edit, as reported
 * to the Properties panel. Mirrors the server's `StudioEditRefusal` /
 * `StudioEditSwapDetail` shapes (`server/handlers/studioWriteback.ts`)
 * one-for-one, without importing them — same "browser/server agree on the
 * wire shape, not the type" split every other schema here follows.
 */
export type InstanceCodemodResult =
  | { ok: true; swapDetail?: { removedProps: string[]; unfilledRequiredProps: string[] } }
  | { ok: false; reason: string; message: string }

/**
 * WS-4.5 — the Properties panel's Swap action. On success, `swapDetail` names
 * the props the new component dropped and the required props it still needs —
 * the codemod's own numbers, never re-derived here.
 *
 * DET-4 — ⌘Z puts the call site back exactly as it was, dropped props and
 * all (`journaledUndo.ts`); ⌘⇧Z swaps again.
 */
export async function swapInstance(
  nodeId: string,
  target: { newComponentName: string; newComponentSource: 'local' | 'package'; newComponentFile: string },
): Promise<InstanceCodemodResult> {
  const edit = { kind: 'swap', nodeId, ...target }
  const result = await postOneEdit(edit)
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) {
    requestCmsSiteReload({ structuralOutcome: journaledWriteOutcome(`Swap to ${target.newComponentName}`, [edit], result.undoToken) })
  }
  const swapDetail = (result.swapDetails ?? []).find((detail) => detail.nodeId === nodeId)
  return { ok: true, swapDetail }
}

/**
 * One prop value an insert can write — the browser's mirror of
 * `studioStructuralWriteback.ts`'s `JsxPropValueSchema`, declared here rather
 * than imported from `@core/ast-codemods` for the same reason `SlotJsxNode`
 * below is: that module pulls in ts-morph, which must never reach the browser.
 *
 * The `{ __jsx }` member is a React ELEMENT in prop position —
 * `<TabBar items={[{ icon: <svg…/>, label: 'Home' }]}/>`, the documented shape
 * of a tab bar. It carries a validated element tree, never source text, and the
 * server runs it through the same tag-safety refusal every child element gets.
 */
export type InsertPropValue =
  | string
  | number
  | boolean
  | null
  | { __jsx: SlotJsxNode }
  | InsertPropValue[]
  | { [key: string]: InsertPropValue }

/**
 * One element written into a slot — the browser's mirror of
 * `studioSlotWriteback.ts`'s `SlotJsxNodeSchema`, which is what actually
 * validates it on arrival (and is itself `insertJsxElement`'s own
 * `InsertJsxNode`). Declared here rather than imported from
 * `@core/ast-codemods` because that module pulls in ts-morph, which must
 * never reach the browser bundle — the same posture `registerProjectModules.ts`
 * takes for `ICON_PROP_SVG_KEY`.
 *
 * A package-component fill names its `importSpecifier`; a built-in
 * design-system component names `designSystemImport` and lets the server
 * compute the relative path (see `commitStudioInsert`); an inline SVG icon
 * (`svgToJsxNode.ts`) is a tree of intrinsic tags and names neither.
 */
export interface SlotJsxNode {
  name: string
  importSpecifier?: string
  designSystemImport?: true
  props?: Record<string, JsonDataValue>
  children?: string | SlotJsxNode[]
}

/**
 * E2.5 — the Properties panel's slot "Add"/"Add another" action:
 * `insert-slot` (E2.4, `insertJsxIntoSlotProp`). `nodeId` is the CALL SITE's
 * own (plain, un-prefixed) id — the slot being filled is one of ITS
 * attributes, never the `studio.slot` container's own id (which is locked
 * structurally and would wrongly refuse `code-placed` — see E2.4's own
 * handoff, "wall #3"). `propName` is the raw slot name (`'header'`), never
 * `callSiteProps:`-prefixed.
 *
 * Always reloads on a successful write (`shifted` is unconditionally `true`
 * for this kind, same as `detach`/`swap`/`insert`) — the filled node has no
 * honest id until the codemod has written it and the board re-parses.
 */
export async function commitStudioInsertSlot(fill: {
  nodeId: string
  propName: string
  node: SlotJsxNode
  /** `'replace'` swaps whatever the slot holds for `node`; omitted adds alongside it. */
  mode?: 'append' | 'replace'
}): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({
    kind: 'insert-slot',
    nodeId: fill.nodeId,
    propName: fill.propName,
    node: fill.node,
    ...(fill.mode ? { mode: fill.mode } : {}),
  })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  return { ok: true }
}

/** POST /admin/api/studio/extract-component response — see that route's module doc. */
const ExtractComponentResponseSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    newFile: Type.String(),
    newComponentName: Type.String(),
    /** P3-F — puts the call site back and removes the copy. */
    undoToken: Type.Optional(UndoTokenSchema),
  }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), message: Type.String() }),
])

/**
 * WS-4.4's detach-refusal escape hatch — the Properties panel's "Card uses
 * useState — duplicate it as Card2.tsx and edit that instead?" offer.
 * Duplicates the instance's own component under a fresh name and repoints
 * THIS call site at the copy; always reloads on success (a brand-new file
 * plus a rewritten import is exactly the shape of edit that invalidates
 * in-memory node ids downstream of it).
 *
 * DET-4 — pushes its own undo entry (`journaledUndo.ts`): ⌘Z points the call
 * site back and deletes the copy. `undo: 'caller'` is for the one caller that
 * records a different entry for the same write (`instanceOnlyGesture.ts`,
 * whose replayed gesture is linked to it).
 */
export async function extractInstanceCopy(
  nodeId: string,
  options: { undo?: 'caller' } = {},
): Promise<InstanceCodemodResult & { newFile?: string; newComponentName?: string }> {
  const result = await apiRequest('/admin/api/studio/extract-component', {
    method: 'POST',
    body: { dir: studioWriteDir(), nodeId },
    schema: ExtractComponentResponseSchema,
  })
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
  requestCmsSiteReload(
    options.undo === 'caller' ? {} : { structuralOutcome: journaledWriteOutcome(`Duplicate as ${result.newComponentName}`, [], result.undoToken) },
  )
  return { ok: true, newFile: result.newFile, newComponentName: result.newComponentName }
}
