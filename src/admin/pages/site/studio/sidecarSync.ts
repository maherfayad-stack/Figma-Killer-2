/**
 * sidecarSync — the `.studio/` EDITOR-OWNED settings round trip, on both ends.
 *
 * Two `SiteSettings` fields have no home in the user's `.tsx`/`.css` source
 * and therefore no place in the per-node edit batch `fsCodemodAdapter` ships:
 *
 *   - `settings.framework` — the Framework panel's design tokens
 *     (colors / typography scale / spacing scale), in `.studio/framework.json`;
 *   - `settings.fonts` — the installed font library (`@font-face` entries and
 *     the `var(--font-*)` tokens bound to them), in `.studio/fonts.json`.
 *
 * Both travel on ONE route (`/admin/api/studio/framework`) because they are
 * loaded and saved on exactly the same beats; they stay SEPARATE FILES because
 * they are separate fields with separate owners, and folding one into the
 * other on disk would give the same data two homes.
 *
 * ## Why fonts got here late (`font-revert`)
 *
 * `settings.fonts` had the gap `server/handlers/studioFramework.ts`'s doc
 * describes for the Framework panel, and it outlived that fix by a long way:
 * `FrameworkSettingsSchema` has no `fonts` field and `saveSite` only ever
 * posted `settings.framework`. Installing a font therefore mutated the store
 * and NOTHING else — the woff2 binaries landed under `uploads/fonts/`, the
 * `FontEntry` pointing at them never reached disk, and the next load showed an
 * empty "Installed fonts" group in the family picker with every `var(--font-*)`
 * token the user had assigned resolving to nothing. The user's report was
 * exactly that: "even after installing the font from the framework it's the
 * same".
 *
 * ## Absent ≠ empty
 *
 * A POST omits a field when that field did not change this round, and the
 * server leaves the matching sidecar untouched. Sending `{ items: [] }` for a
 * save that merely didn't touch fonts would DELETE the user's library. This
 * is why both fields are optional in `FrameworkPostBodySchema` and why the
 * response echoes back `null` for whichever kind it did not write.
 *
 * ## The baselines are module state
 *
 * `lastSyncedFrameworkJson` / `lastSyncedFontsJson` answer "did this actually
 * change since the last load or save?", so a framework-only edit still
 * persists (no node edits at all) and an unchanged one costs no request.
 * `JSON.stringify(undefined)` is `undefined`, not `"null"` — kept that way on
 * purpose so "this project has no library" compares equal to "never had one"
 * and cannot fire a spurious POST on a project with no fonts.
 */
import { Type } from '@sinclair/typebox'
import { apiRequest } from '@core/http'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { SiteFontsSettingsSchema } from '@core/fonts'
import type { SiteDocument } from '@core/page-tree'

/**
 * GET response. `null` for a kind the project has never persisted — the
 * caller's own default (already built by `createDefaultSiteDocument`) stands.
 */
const SidecarLoadResponseSchema = Type.Object({
  framework: Type.Union([FrameworkSettingsSchema, Type.Null()]),
  fonts: Type.Union([SiteFontsSettingsSchema, Type.Null()]),
})

/** POST response — each field echoes back only what this save actually wrote. */
const SidecarSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  framework: Type.Union([FrameworkSettingsSchema, Type.Null()]),
  fonts: Type.Union([SiteFontsSettingsSchema, Type.Null()]),
})

let lastSyncedFrameworkJson: string | undefined
let lastSyncedFontsJson: string | undefined

/**
 * Read both sidecars into `site.settings`, then arm the change baselines.
 * Mutates `site` in place, matching the rest of `loadSite`'s shell assembly.
 */
export async function loadSidecarSettings(
  site: SiteDocument,
  overrideDir: string | null,
): Promise<void> {
  const { framework, fonts } = await apiRequest('/admin/api/studio/framework', {
    schema: SidecarLoadResponseSchema,
    query: overrideDir ? { dir: overrideDir } : undefined,
  })
  if (framework) site.settings.framework = framework
  if (fonts) site.settings.fonts = fonts
}

/**
 * Arm the baselines to the site as it now stands. Called at the END of
 * `loadSite` — after token extraction, which rewrites `settings.framework` —
 * so the first save after a load diffs against what the load actually landed
 * on, not against an intermediate value.
 */
export function armSidecarBaselines(site: SiteDocument): void {
  lastSyncedFrameworkJson = JSON.stringify(site.settings.framework)
  lastSyncedFontsJson = JSON.stringify(site.settings.fonts)
}

/**
 * POST whichever sidecar-owned settings changed since the last load/save.
 * No-op — and no request at all — when neither did.
 */
export async function saveChangedSidecarSettings(
  site: SiteDocument,
  dir: string | null,
): Promise<void> {
  const nextFrameworkJson = JSON.stringify(site.settings.framework)
  const nextFontsJson = JSON.stringify(site.settings.fonts)
  const frameworkChanged = nextFrameworkJson !== lastSyncedFrameworkJson
  const fontsChanged = nextFontsJson !== lastSyncedFontsJson
  if (!frameworkChanged && !fontsChanged) return

  await apiRequest('/admin/api/studio/framework', {
    method: 'POST',
    // See "Absent ≠ empty" above: a field left out means "no change of that
    // kind", which must never be read as "clear it".
    body: {
      dir,
      ...(site.settings.framework ? { framework: site.settings.framework } : {}),
      ...(fontsChanged && site.settings.fonts ? { fonts: site.settings.fonts } : {}),
    },
    schema: SidecarSaveResponseSchema,
  })
  lastSyncedFrameworkJson = nextFrameworkJson
  lastSyncedFontsJson = nextFontsJson
}

/**
 * Adopt `framework` as the framework baseline WITHOUT posting it — for the
 * Framework panel's "Re-scan tokens", which applies a value the server just
 * handed back. Re-posting it would be a round trip that writes what is
 * already on disk.
 */
export function noteFrameworkSynced(framework: SiteDocument['settings']['framework']): void {
  lastSyncedFrameworkJson = JSON.stringify(framework)
}

/**
 * Clear both baselines. Module-level state survives across test FILES in one
 * `bun test` process, so a suite that installs a font and saves leaves
 * `lastSyncedFontsJson` set for every file that runs after it — and a later
 * suite calling `saveSite` WITHOUT a `loadSite` then sees a spurious "the
 * library changed" and fires an extra POST it does not expect. The same hazard
 * always existed for the framework baseline; it only became observable once a
 * second one joined it. Same shape as `__resetToastBusForTests`.
 */
export function __resetSidecarBaselinesForTests(): void {
  lastSyncedFrameworkJson = undefined
  lastSyncedFontsJson = undefined
}
