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
 * all need the same three things, which is exactly what this module holds: the
 * response schema, the active workspace dir, and the reload-on-success rule.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { pushToast } from '@ui/components/Toast'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

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
})

export type StudioSaveResponse = Static<typeof StudioSaveResponseSchema>

/**
 * Remembered from the last load so every save can tell the server which
 * folder to write. Module state rather than a store slice for the same reason
 * `componentSources` is: it is ephemeral, server-derived, per-load state, not
 * part of the persisted `SiteDocument` shape.
 */
let loadedDir: string | null = null

export function setStudioLoadedDir(dir: string | null): void {
  loadedDir = dir
}

/**
 * The dir every studio write targets: the explicitly-selected project when
 * there is one, otherwise whatever the last load reported. Every call in this
 * module resolves it the same way so a one-shot commit can never land in a
 * different project than the canvas is showing.
 */
export function studioWriteDir(): string | null {
  return getStudioWorkspaceDir() ?? loadedDir
}

/** POST /admin/api/studio/page response — the newly scaffolded page. */
const StudioCreatePageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  relPath: Type.String(),
  /** Kebab id derived from the file path — the value a board frame references. */
  pageId: Type.String(),
  title: Type.String(),
})
export type CreatedStudioPage = Static<typeof StudioCreatePageResponseSchema>

/**
 * Creates a new page (`pages/<Component>.tsx` with a starter component) in the
 * active project and resolves to its `{ pageId, title }`. Targets the SAME
 * `dir` every other studio call uses, so the file lands in the project the
 * canvas is currently showing. `name` is optional — omit it and the server
 * auto-names the page `Page`, `Page2`, …. Throws `ApiError` on failure (e.g. a
 * name collision → 409) so the caller can toast the message. The caller
 * reloads the workspace afterwards (`requestCmsSiteReload`) to render it.
 */
export function createStudioPage(name?: string): Promise<CreatedStudioPage> {
  const overrideDir = getStudioWorkspaceDir()
  const body: { name?: string; dir?: string } = {}
  if (name) body.name = name
  if (overrideDir) body.dir = overrideDir
  return apiRequest('/admin/api/studio/page', {
    method: 'POST',
    body,
    schema: StudioCreatePageResponseSchema,
  })
}

/** Post one edit to `/save` and return the parsed response. The shared body of every one-shot commit below. */
function postOneEdit(edit: Record<string, unknown>): Promise<StudioSaveResponse> {
  return apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: studioWriteDir(), edits: [edit] },
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
