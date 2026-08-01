/**
 * previewAxesCapability — WS-10 Phase 1: the client's read side for
 * `.studio/meta.json`'s persisted `previewAxes`, plus the project probe's
 * `colorScheme` capability the dark-mode toggle needs to know whether (and
 * how) it applies. Same "tiny external store" pattern
 * `studioProjectTrust.ts` uses for per-project client state that isn't part
 * of the persisted `SiteDocument` — `PreviewAxesControls.tsx` and
 * `IframeFrameSurface.tsx` both read the capability store via
 * `useSyncExternalStore` without threading a prop through every frame.
 *
 * `PreviewAxes` itself is imported from `@core/studio-board` rather than
 * duplicated here — unlike `TrustTierSchema` (whose source lives in a
 * server-only file), that leaf has zero Node dependencies and is already a
 * normal admin-code import, so there is one definition, not two that could
 * drift.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { DEFAULT_PREVIEW_AXES, PreviewAxesSchema, type PreviewAxes } from '@core/studio-board'

// ---------------------------------------------------------------------------
// Persisted axes — GET/POST /admin/api/studio/preview-axes
// ---------------------------------------------------------------------------

const PreviewAxesResponseSchema = Type.Object({ previewAxes: PreviewAxesSchema })

/** The full resolved axes (defaults filled in) — never throws; a network failure just leaves the board on `DEFAULT_PREVIEW_AXES`. */
export async function fetchPersistedPreviewAxes(dir: string): Promise<PreviewAxes> {
  try {
    const { previewAxes } = await apiRequest('/admin/api/studio/preview-axes', {
      schema: PreviewAxesResponseSchema,
      query: { dir },
    })
    return previewAxes
  } catch (err) {
    console.error('[previewAxesCapability] failed to load persisted preview axes:', err)
    return DEFAULT_PREVIEW_AXES
  }
}

/** Persists a PARTIAL update — the server merges it onto whatever is already stored (`mergeStudioMeta`), so a direction toggle never clobbers a previously-saved color scheme and vice versa. */
export async function savePreviewAxes(dir: string, patch: Partial<PreviewAxes>): Promise<void> {
  try {
    await apiRequest('/admin/api/studio/preview-axes', {
      method: 'POST',
      body: { dir, previewAxes: patch },
      schema: Type.Object({ ok: Type.Boolean() }),
    })
  } catch (err) {
    console.error('[previewAxesCapability] failed to persist preview axes:', err)
  }
}

// ---------------------------------------------------------------------------
// Dark-mode capability — GET /admin/api/studio/probe (already exists, WS-1.2)
// ---------------------------------------------------------------------------

/**
 * Mirrors `ColorSchemeCapabilitySchema` in
 * `server/handlers/studio/projectProfileSchema.ts` — this file runs in the
 * browser, so (same reasoning as `studioProjectTrust.ts`'s `TrustTierSchema`)
 * it only needs to agree on the wire shape, not import the server module.
 */
const ColorSchemeCapabilitySchema = Type.Object({
  mechanism: Type.Union([Type.Literal('media'), Type.Literal('class'), Type.Literal('none')]),
  selector: Type.Optional(Type.String()),
})
export type ColorSchemeCapability = Static<typeof ColorSchemeCapabilitySchema>

const ProbeResponseSchema = Type.Object({
  profile: Type.Object({ colorScheme: ColorSchemeCapabilitySchema }),
})

let colorSchemeCapability: ColorSchemeCapability | null = null
const listeners = new Set<() => void>()

/** `null` until the first successful probe fetch for the currently open project — `IframeFrameSurface.tsx` treats `null` as "unknown yet, apply nothing beyond the generic attribute" (see `applyPreviewAxesToFrameDocument`). */
export function getColorSchemeCapability(): ColorSchemeCapability | null {
  return colorSchemeCapability
}

export function subscribeColorSchemeCapability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setColorSchemeCapability(next: ColorSchemeCapability | null): void {
  colorSchemeCapability = next
  for (const listener of listeners) listener()
}

/** Fetches the current project's dark-mode capability via the existing project-probe route and publishes it to the external store. Never throws — a failed probe just leaves the capability `null` (toolbar renders disabled with a generic reason; see `PreviewAxesControls.tsx`). */
export async function refreshColorSchemeCapability(dir: string): Promise<void> {
  try {
    const { profile } = await apiRequest('/admin/api/studio/probe', {
      schema: ProbeResponseSchema,
      query: { dir },
    })
    setColorSchemeCapability(profile.colorScheme)
  } catch (err) {
    console.error('[previewAxesCapability] failed to probe color-scheme capability:', err)
    setColorSchemeCapability(null)
  }
}

/** Resets the capability store — called when the open project changes, so a moment of stale "project A's capability" is never read as if it were project B's. */
export function clearColorSchemeCapability(): void {
  setColorSchemeCapability(null)
}
