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
// Dark-mode + locale capability — GET /admin/api/studio/probe (already
// exists, WS-1.2). One probe response carries both — see `ProbeResponseSchema`
// below — so one fetch refreshes both external stores together.
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

/** Mirrors `LocalesCapabilitySchema` in `server/handlers/studio/projectProfileSchema.ts` — WS-10 §4.1. */
const LocalesCapabilitySchema = Type.Object({
  keys: Type.Array(Type.String()),
  defaultKey: Type.Optional(Type.String()),
  source: Type.String(),
})
export type LocalesCapability = Static<typeof LocalesCapabilitySchema>

const ProbeResponseSchema = Type.Object({
  profile: Type.Object({
    colorScheme: ColorSchemeCapabilitySchema,
    locales: Type.Optional(LocalesCapabilitySchema),
  }),
})

let colorSchemeCapability: ColorSchemeCapability | null = null
let localesCapability: LocalesCapability | null = null
const listeners = new Set<() => void>()

/** `null` until the first successful probe fetch for the currently open project — `IframeFrameSurface.tsx` treats `null` as "unknown yet, apply nothing beyond the generic attribute" (see `applyPreviewAxesToFrameDocument`). */
export function getColorSchemeCapability(): ColorSchemeCapability | null {
  return colorSchemeCapability
}

/** `null` until the first successful probe fetch, OR when the probe genuinely found no locale dictionary — `PreviewAxesControls.tsx` treats both the same way: the locale control renders disabled with a reason (WS-10 §7.4 "probe honesty"). */
export function getLocalesCapability(): LocalesCapability | null {
  return localesCapability
}

export function subscribeColorSchemeCapability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Same underlying listener set as `subscribeColorSchemeCapability` — both capabilities refresh together from one probe fetch (`refreshPreviewCapabilities`), so there is no benefit to two separate subscription lists. */
export function subscribeLocalesCapability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyCapabilityListeners(): void {
  for (const listener of listeners) listener()
}

/** Fetches the current project's dark-mode AND locale capabilities via the existing project-probe route and publishes both to their external stores in one notification. Never throws — a failed probe just leaves both capabilities `null` (toolbar renders both controls disabled with a reason; see `PreviewAxesControls.tsx`). */
export async function refreshPreviewCapabilities(dir: string): Promise<void> {
  try {
    const { profile } = await apiRequest('/admin/api/studio/probe', {
      schema: ProbeResponseSchema,
      query: { dir },
    })
    colorSchemeCapability = profile.colorScheme
    localesCapability = profile.locales ?? null
  } catch (err) {
    console.error('[previewAxesCapability] failed to probe preview capabilities:', err)
    colorSchemeCapability = null
    localesCapability = null
  }
  notifyCapabilityListeners()
}

/** Resets both capability stores — called when the open project changes, so a moment of stale "project A's capability" is never read as if it were project B's. */
export function clearPreviewCapabilities(): void {
  colorSchemeCapability = null
  localesCapability = null
  notifyCapabilityListeners()
}
