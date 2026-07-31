/**
 * frameDefaultsApi — client for `/admin/api/studio/frame-defaults` (WS-7.2).
 *
 * A per-project default frame width/height, persisted in `.studio/meta.json`'s
 * `frameDefaults` (`server/handlers/studio/studioMeta.ts`). `fetchFrameDefaults`
 * hydrates `boardSlice.frameDefaults` alongside the boards load
 * (`AdminCanvasLayout`'s `useStudioBoardsPersistence`); `saveFrameDefaults` is
 * called by the bulk frame inspector's "apply to all pages" action AFTER the
 * store's own `applyWidthToAllFrames` has already updated every frame's width
 * and the local `frameDefaults` mirror — the store stays a pure state
 * container, this module owns the network round-trip.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import type { FrameDefaults } from '@site/store/slices/boardSlice'

const FrameDefaultsSchema = Type.Object({
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
})

const FrameDefaultsGetResponseSchema = Type.Object({
  dir: Type.String(),
  frameDefaults: FrameDefaultsSchema,
})

const FrameDefaultsPostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  frameDefaults: FrameDefaultsSchema,
})

/** Fetch the saved frame defaults for `dir` (server default workspace when omitted). */
export async function fetchFrameDefaults(dir?: string): Promise<FrameDefaults> {
  const res = await apiRequest('/admin/api/studio/frame-defaults', {
    schema: FrameDefaultsGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return res.frameDefaults
}

/**
 * Merge `patch` into the saved frame defaults for `dir`. Only the fields
 * present in `patch` are overwritten — omit `height` to leave a
 * previously-saved default height untouched.
 */
export async function saveFrameDefaults(patch: FrameDefaults, dir?: string): Promise<FrameDefaults> {
  const res = await apiRequest('/admin/api/studio/frame-defaults', {
    method: 'POST',
    body: { dir, width: patch.width, height: patch.height },
    schema: FrameDefaultsPostResponseSchema,
  })
  return res.frameDefaults
}
