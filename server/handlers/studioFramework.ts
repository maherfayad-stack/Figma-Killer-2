/**
 * studioFramework — filesystem persistence for a studio project's Framework
 * design-token settings (`SiteSettings.framework`: colors, typography scale,
 * spacing scale, preferences).
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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FrameworkSettingsSchema, type FrameworkSettings } from '@core/framework-schema'
import { safeParseValue } from '@core/utils/typeboxHelpers'

function frameworkFilePath(dir: string): string {
  return join(dir, '.studio', 'framework.json')
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
