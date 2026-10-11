/**
 * snapPreferences — the user's snap toggles (P5-F, IX-5e), and where they
 * survive a reload.
 *
 * Two independent switches, the pair Penpot and Figma both offer:
 *
 *  - **objects** — siblings, the parent's edges and centre, other board
 *    furniture, and equal spacing (⌘⇧');
 *  - **ruler guides** — the persisted guides dragged out of the rulers (⌘').
 *
 * They are a preference of the PERSON, not of the project (a designer who
 * hates snapping hates it everywhere), so they live in `localStorage` rather
 * than in `.studio/meta.json`. TypeBox-validated on read like every other
 * persisted value: a missing or malformed entry is "both on", the default.
 *
 * The store holds the live value (`canvasSlice.snapPreferences`); the
 * gestures read it once per gesture and apply it through `snapSourcesFor`
 * (`boardSnapping.ts`), the one place the toggles take effect.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

export const SnapPreferencesSchema = Type.Object({
  objects: Type.Boolean(),
  guides: Type.Boolean(),
})

export type SnapPreferences = Static<typeof SnapPreferencesSchema>

export const SNAP_PREFERENCES_STORAGE_KEY = 'studio-snap-preferences-v1'

export const DEFAULT_SNAP_PREFERENCES: SnapPreferences = { objects: true, guides: true }

/** The stored toggles, or both on. Never throws. */
export function readSnapPreferences(): SnapPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_SNAP_PREFERENCES
  try {
    return parseJsonWithFallback(
      localStorage.getItem(SNAP_PREFERENCES_STORAGE_KEY),
      SnapPreferencesSchema,
      DEFAULT_SNAP_PREFERENCES,
    )
  } catch (_err) {
    // A storage that throws on read (a locked-down profile) is "no preference".
    return DEFAULT_SNAP_PREFERENCES
  }
}

/** Best-effort write — a full or disabled storage keeps the toggle for this session only. */
export function writeSnapPreferences(preferences: SnapPreferences): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SNAP_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch (err) {
    console.warn('[snapPreferences] could not persist the snap toggles:', err)
  }
}
