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
import { recordCreatedStylesheet, ruleIdFromCssCreateNodeId } from './styleRuleWriteback'

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
   * `STUDIO-FIGMA-PARITY-PLAN.md` item 0.7 — every edit that skipped with no
   * matching `refusals` entry (`StudioEditUnexplainedSkip` on the server —
   * `server/handlers/studioWriteback.ts`), i.e. exactly the set the
   * `unexplainedSkips` toast in `fsCodemodAdapter.ts` currently reports only
   * as a bare count. `Type.Optional`, same tolerant-rollout reasoning as
   * `refusals`/`swapDetails` above — an older server build simply omits it,
   * and the client falls back to `result.skipped - refusals.length`.
   */
  unexplainedSkips: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    kind: Type.String(),
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
})

export type StudioSaveResponse = Static<typeof StudioSaveResponseSchema>

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
 * existing `unexplainedSkips`/`shifted` handling.
 */
export function notifyCreatedStylesheets(
  result: StudioSaveResponse,
  styleRules: Record<string, StyleRule>,
): void {
  for (const created of result.createdStylesheets ?? []) {
    const ruleId = ruleIdFromCssCreateNodeId(created.nodeId)
    if (!ruleId) continue
    const rule = styleRules[ruleId]
    recordCreatedStylesheet(ruleId, created.file, rule?.selector ?? '')
    pushToast({
      kind: 'success',
      title: 'Stylesheet created',
      body: rule
        ? `Studio created ${created.file} and wired it into your page for “${rule.name}”.`
        : `Studio created ${created.file} and wired it into your page.`,
    })
  }
}

/** Post one edit to `/save` and return the parsed response. The shared body of every one-shot commit below. */
function postOneEdit(edit: Record<string, unknown>): Promise<StudioSaveResponse> {
  return postEdits([edit])
}

/** Post a batch of edits to `/save`. The save route orders them bottom-to-top before applying. */
export function postEdits(edits: readonly Record<string, unknown>[]): Promise<StudioSaveResponse> {
  return apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: studioWriteDir(), edits },
    schema: StudioSaveResponseSchema,
  })
}

/**
 * Commits ONE `kind: 'asset'` edit immediately — WS-8.3's "replace this
 * image" action — instead of letting the ordinary optimistic prop-diff loop
 * in `saveSite` pick it up:
 *
 *   - An image swap is a discrete, deliberate commit (pick a file, confirm),
 *     not a value the user is continuously typing — nothing to debounce.
 *   - The edit's target is `PageNode.assetOrigin` (the import declaration),
 *     never the node's own `src` prop — writing it as an ordinary prop diff
 *     would need `updateNodeProps`'s codeProps guard to special-case this one
 *     prop, which the store slices do not currently know how to do.
 *   - The save route ALWAYS reports an asset edit as shared
 *     (`isSharedSourceNodeId`'s `kind === 'asset'` branch) because the import
 *     it rewrites can back more than one node — so this always reloads on a
 *     successful write, the same remedy `saveSite` uses for `shifted`/
 *     `sharedComponents`, without waiting for the next autosave tick.
 *
 * `nodeId` is the ORIGIN's own `rel:line:col` (`PageNode.assetOrigin`), not
 * the editing node's id — same convention the `literal` edit kind uses for
 * resolved text. `assetPath` is the new file's workspace-relative POSIX path.
 */
export async function saveStudioAssetEdit(nodeId: string, assetPath: string): Promise<void> {
  const result = await postOneEdit({ kind: 'asset', nodeId, assetPath })

  if (result.skipped > 0) {
    pushToast({
      kind: 'error',
      title: 'Image was not saved to source',
      body: 'The import naming this image could not be rewritten — it may no longer exist at the location the canvas last saw.',
    })
    return
  }
  if (result.written > 0) requestCmsSiteReload()
}

/**
 * instance-ui-01 — the outcome of a single `detach`/`swap` edit, as reported
 * to the Properties panel. Mirrors the server's `StudioEditRefusal` /
 * `StudioEditSwapDetail` shapes (`server/handlers/studioWriteback.ts`)
 * one-for-one, without importing them — same "browser/server agree on the
 * wire shape, not the type" split every other schema here follows.
 */
export type InstanceCodemodResult =
  | { ok: true; swapDetail?: { removedProps: string[]; unfilledRequiredProps: string[] } }
  | { ok: false; reason: string; message: string }

/**
 * WS-4.4 — the Properties panel's Detach action. Detach is a deliberate,
 * one-shot structural rewrite (replace the call site with its own inlined
 * JSX), not a value the diff loop's "what did the user type" model fits.
 *
 * A refusal (`uses-hooks`, `maps-over-props`, …) is a NAMED, expected
 * outcome — returned to the caller rather than just toasted, so the panel
 * can offer the `extractInstanceCopy` escape hatch inline for the specific
 * reasons that warrant it. `detach` always shifts lines and is always
 * reported `sharedComponents` by the server, so a successful write always
 * reloads the board — the detached node's OWN id is about to become stale.
 */
export async function detachInstance(nodeId: string): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({ kind: 'detach', nodeId })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  return { ok: true }
}

/**
 * WS-4.5 — the Properties panel's Swap action. On success, `swapDetail` names
 * the props the new component dropped and the required props it still needs —
 * the codemod's own numbers, never re-derived here.
 */
export async function swapInstance(
  nodeId: string,
  target: { newComponentName: string; newComponentSource: 'local' | 'package'; newComponentFile: string },
): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({ kind: 'swap', nodeId, ...target })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
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
 * A component fill names its `importSpecifier`; an inline SVG icon
 * (`svgToJsxNode.ts`) is a tree of intrinsic tags and names none.
 */
export interface SlotJsxNode {
  name: string
  importSpecifier?: string
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
  Type.Object({ ok: Type.Literal(true), newFile: Type.String(), newComponentName: Type.String() }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), message: Type.String() }),
])

/**
 * WS-4.4's detach-refusal escape hatch — the Properties panel's "Card uses
 * useState — duplicate it as Card2.tsx and edit that instead?" offer.
 * Duplicates the instance's own component under a fresh name and repoints
 * THIS call site at the copy; always reloads on success (a brand-new file
 * plus a rewritten import is exactly the shape of edit that invalidates
 * in-memory node ids downstream of it).
 */
export async function extractInstanceCopy(nodeId: string): Promise<InstanceCodemodResult & { newFile?: string; newComponentName?: string }> {
  const result = await apiRequest('/admin/api/studio/extract-component', {
    method: 'POST',
    body: { dir: studioWriteDir(), nodeId },
    schema: ExtractComponentResponseSchema,
  })
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
  requestCmsSiteReload()
  return { ok: true, newFile: result.newFile, newComponentName: result.newComponentName }
}
