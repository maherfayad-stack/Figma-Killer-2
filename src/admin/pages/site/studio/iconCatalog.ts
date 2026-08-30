/**
 * iconCatalog — the client half of `GET /admin/api/studio/icons`
 * (`server/handlers/studio/iconCatalog.ts`): every SVG icon the project's
 * installed component packages ship as FILES, which is where a real design
 * system keeps its icon set.
 *
 * Cached per workspace dir and fetched once, on the slot picker's "Add"
 * click — never from a selector or a per-keystroke path — exactly the
 * `componentCatalog.ts` precedent, and for a stronger reason here: the
 * response carries each icon's markup so the picker can PREVIEW it, which is
 * a few hundred KB for a full design system. Once per project, or not at all
 * if the user never opens an icon slot.
 *
 * Never throws: a failed fetch resolves to an empty catalog (logged), which
 * the picker renders as "no icons", never as a broken panel.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioSaveRequests'

export const StudioIconSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  group: Type.String(),
  pkg: Type.String(),
  /** RAW file text. Sanitise with `sanitizeSvg` before rendering or converting — the server has no DOM to do it. */
  markup: Type.String(),
})
export type StudioIcon = Static<typeof StudioIconSchema>

const IconsResponseSchema = Type.Object({ icons: Type.Array(StudioIconSchema) })

let cache: { dir: string | undefined; promise: Promise<StudioIcon[]> } | null = null

export function fetchStudioIconCatalog(): Promise<StudioIcon[]> {
  const dir = studioWriteDir() ?? undefined
  if (cache && cache.dir === dir) return cache.promise
  const promise = apiRequest('/admin/api/studio/icons', { query: { dir }, schema: IconsResponseSchema })
    .then((res) => res.icons)
    .catch((err) => {
      console.error('[iconCatalog] fetch failed:', err)
      return []
    })
  cache = { dir, promise }
  return promise
}

/** Drops the cached catalog — call after an install/remove changes which packages are present. */
export function invalidateStudioIconCatalog(): void {
  cache = null
}
