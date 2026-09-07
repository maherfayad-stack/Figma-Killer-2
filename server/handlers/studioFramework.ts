/**
 * studioFramework — filesystem persistence for a studio project's Framework
 * design-token settings (`SiteSettings.framework`: colors, typography scale,
 * spacing scale, preferences) AND its installed font library
 * (`SiteSettings.fonts`: `@font-face` entries + font tokens).
 *
 * Until this module, studio mode had NO persistence story for these at
 * all: `fsCodemodAdapter.loadSite()` always rebuilt a fresh default site
 * shell (see its doc comment), and `saveSite()` only ever wrote per-node
 * prop/text/style edits back to `.tsx` source — any Colors/Typography/Spacing
 * panel edit was silently lost on the next reload. This adds a
 * `<project>/.studio/framework.json` sidecar file, read on load and written
 * on save — the exact same pattern `.studio/boards.json` already uses for the
 * board layout (`server/handlers/studio.ts`'s boards GET/POST routes), just
 * for a different piece of editor-owned (not page-source) state.
 *
 * Read is defensive (never throws — a missing or corrupted file just means
 * "nothing stored yet," same philosophy as `parseBoardsFile`). Write is
 * strict (rejects a shape that doesn't validate against
 * `FrameworkSettingsSchema` — this is about to become the persisted source of
 * truth, unlike a soft-fallback read).
 *
 * ## `.studio/fonts.json` — why fonts get their OWN sidecar (`font-revert`)
 *
 * `SiteSettings.fonts` had exactly the gap this module's first paragraph
 * describes for the Framework panel, and it survived long after that one was
 * closed: `FrameworkSettingsSchema` has no `fonts` field, `saveSite` only
 * ever posted `site.settings.framework`, so installing a font — Google or
 * custom — mutated `site.settings.fonts` in memory and NOTHING ELSE. The
 * binaries landed under `uploads/fonts/`, the `FontEntry` never reached disk,
 * and the next reload showed an empty "Installed fonts" group. The user's
 * report was exactly that: "even after installing the font from the framework
 * it's the same".
 *
 * It is a SEPARATE file, not a new `FrameworkSettingsSchema` field, because
 * `site.settings.fonts` and `site.settings.framework` are two different
 * fields of `SiteSettings` with two different owners. Folding fonts under
 * `framework` on disk would create a second home for the same data and force
 * every reader to know which one won — the "no two ways of doing something"
 * rule. Same directory, same round trip (`/admin/api/studio/framework`
 * carries both), independent files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FrameworkSettingsSchema, type FrameworkSettings } from '@core/framework-schema'
import { SiteFontsSettingsSchema, parseSiteFontsSettings, type SiteFontsSettings } from '@core/fonts'
import { safeParseValue } from '@core/utils/typeboxHelpers'

function frameworkFilePath(dir: string): string {
  return join(dir, '.studio', 'framework.json')
}

function fontsFilePath(dir: string): string {
  return join(dir, '.studio', 'fonts.json')
}

/**
 * Reads `<dir>/.studio/framework.json`, or `null` when it doesn't exist or
 * doesn't validate against `FrameworkSettingsSchema` — the caller's own
 * default (already built by `createDefaultSiteDocument`) stands in either
 * way, so a missing/corrupt file never blocks loading the project.
 */
export function readStudioFrameworkFile(dir: string): FrameworkSettings | null {
  const file = frameworkFilePath(dir)
  if (!existsSync(file)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }

  const result = safeParseValue(FrameworkSettingsSchema, raw)
  return result.ok ? result.value : null
}

/** Validates `raw` against `FrameworkSettingsSchema` and writes it to `<dir>/.studio/framework.json`. Returns the validation result so the route can map a failure to 400 with a useful message. */
export function writeStudioFrameworkFile(
  dir: string,
  raw: unknown,
): { ok: true; value: FrameworkSettings } | { ok: false; message: string } {
  const result = safeParseValue(FrameworkSettingsSchema, raw)
  if (!result.ok) {
    return { ok: false, message: result.errors.map((e) => `${e.path}: ${e.message}`).join('; ') }
  }
  const file = frameworkFilePath(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(result.value))
  return { ok: true, value: result.value }
}

/**
 * Reads `<dir>/.studio/fonts.json`, or `null` when it doesn't exist / isn't
 * JSON. Uses `@core/fonts`'s own tolerant parser rather than a hard schema
 * check so ONE malformed `FontEntry` (a hand-edited file, an older shape)
 * drops that entry instead of throwing the whole library away — the same
 * "drop the bad row, keep the library" contract every site-document loader
 * already applies to this bag.
 */
export function readStudioFontsFile(dir: string): SiteFontsSettings | null {
  const file = fontsFilePath(dir)
  if (!existsSync(file)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }

  return parseSiteFontsSettings(raw)
}

/** Validates `raw` against `SiteFontsSettingsSchema` and writes it to `<dir>/.studio/fonts.json`. Strict, for the same reason the framework write is: this IS the persisted source of truth. */
export function writeStudioFontsFile(
  dir: string,
  raw: unknown,
): { ok: true; value: SiteFontsSettings } | { ok: false; message: string } {
  const result = safeParseValue(SiteFontsSettingsSchema, raw)
  if (!result.ok) {
    return { ok: false, message: result.errors.map((e) => `${e.path}: ${e.message}`).join('; ') }
  }
  const file = fontsFilePath(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(result.value))
  return { ok: true, value: result.value }
}
