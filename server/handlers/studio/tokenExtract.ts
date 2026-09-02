/**
 * tokenExtract — `dir + ProjectProfile -> FrameworkSettings`, per
 * `STUDIO-IMPORT-V2-PLAN.md`'s `tokens-01` work order. Nothing populated
 * Studio's Framework panel (Colors/Typography/Spacing) from an imported
 * project's OWN design tokens — every import started from Studio's empty
 * defaults while the project's real tokens sat unused in its CSS. This
 * module (plus its two split-out collaborators, below) closes that gap by
 * reading `:root` custom properties (and, as a fallback, a Tailwind theme)
 * and turning them into `FrameworkColorToken`/`FrameworkSpacingGroup`/
 * `FrameworkTypographyGroup` entries.
 *
 * Split across five files (module-size-budget discipline, same reason
 * `styleCompile.ts` split into Tier0/Tier1/file-read collaborators):
 *   - `tokenExtractCssScan.ts` — the `:root` scan + var() resolution +
 *     value-first classification engine (`classifyCssText`).
 *   - `tokenExtractTailwind.ts` — the Tailwind theme (`theme` AND
 *     `theme.extend`, merged) static reader (`extractTailwindThemeTokens`).
 *   - `tokenExtractScss.ts` — the Sass `$variable` static reader
 *     (`extractScssVariableTokens`, T6/`STUDIO-FIGMA-PARITY-PLAN.md` §11).
 *   - `tokenExtractJsTheme.ts` — the open-project JS/TS/JSON theme-file
 *     reader (`extractJsThemeTokens`, T6 — reuses
 *     `designImport/parseCssTokens.ts`'s `extractJsTokens`/`extractJsonTokens`,
 *     previously wired only to the EXTERNAL npm/GitHub design-import wizard).
 *   - `tokenExtractBuild.ts` — `ClassifiedTokens -> FrameworkSettings`
 *     (`buildFrameworkSettings`) — the "Shape gap: typography is lossy by
 *     design" doc lives there, next to the code it explains.
 * This file is the orchestrator: try each source in order, merge with
 * whatever's already persisted, and the HTTP route.
 *
 * ## Sources, tried in order — first one that yields at least one classified
 * token wins, and `TokenExtractionResult.source` records which:
 *
 *   1. **`project-css`** — `styleCompile.ts`'s `compileProjectStyles(dir,
 *      profile).styles.css`: CSS Modules (Tier 0) selectors + Sass/PostCSS/
 *      Tailwind (Tier 1, when promoted) output, already concatenated. Reading
 *      FROM that output (rather than re-globbing the workspace) means this
 *      module works through the exact same compiled text Tailwind/Sass/CSS-
 *      Modules projects already produce for the canvas — one producer, two
 *      consumers (`studioCss.ts`'s style-rule registry, and this). This is
 *      also where Tailwind v4's `@theme { ... }` block resolves, once
 *      compiled — `tokenExtractCssScan.ts`'s scanner reads it directly too
 *      (see that module's doc), so a Tier-0 `@theme` block in the project's
 *      OWN uncompiled CSS (not behind a `@import "tailwindcss"` that needs
 *      Tier 1 to resolve) is already covered by this source, not a separate
 *      one.
 *   2. **`tailwind-theme`** — only tried when (1) found nothing AND the probe
 *      detected Tailwind. Static read only — see `tokenExtractTailwind.ts`.
 *   3. **`vendor-css`** — `compiledStyles.vendorCss` (WS-2.3's read-only
 *      package CSS, `canvas-03`). A project that defines no tokens of its own
 *      but imports a design-system package (`@alm-design/design-system` on
 *      the eSIM corpus) gets its tokens from there — this is the source that
 *      corpus actually resolves through, once `node_modules` is installed
 *      (vendor CSS needs no Tier 1 trust promotion, only the package present
 *      on disk — see `styleCompile.ts`'s `collectVendorCss`).
 *   4. **`scss-vars`** — only tried when (1)–(3) found nothing AND the probe
 *      detected Sass. Static read of every `.scss` file's top-level
 *      `$variable` declarations — see `tokenExtractScss.ts`. Weaker signal
 *      than the above (an un-re-exported Sass variable may not reach any
 *      compiled output at all), so tried only once everything stronger has
 *      failed.
 *   5. **`js-theme`** — only tried when (1)–(4) found nothing. A
 *      conventionally-named theme file (`theme`/`tokens`/`design-tokens`/
 *      `colors`/`palette`, any of `.ts`/`.tsx`/`.js`/`.jsx`/`.json`)
 *      anywhere in the OPEN project — see `tokenExtractJsTheme.ts`.
 *
 * `'none'` when every source came up empty — reported honestly via a
 * `no-design-tokens-found` warning, never a fabricated default.
 *
 * ## Merge — never clobber
 *
 * `mergeExtractedFramework` is a WHOLE-FAMILY merge (colors / typography /
 * spacing), the same granularity `mergeStudioMeta` uses for `.studio/
 * meta.json`: a family is only replaced when it is currently EMPTY (no file
 * yet, or a family with zero tokens/groups). The instant the user (or a prior
 * extraction) has put something real into a family, this module never
 * touches it again — "their values win" per the work order, without needing
 * a new provenance field on `FrameworkColorToken`/`FrameworkSpacingGroup`/
 * `FrameworkTypographyGroup` (which are shared, widely-consumed shapes; a
 * marker field there would ripple through the Colors/Typography/Spacing
 * panels for a benefit this coarser merge already gets for free).
 *
 * ## Relationship to `server/handlers/designImport.ts`
 *
 * That module is a DIFFERENT, already-shipped feature with a different
 * TRIGGER: a user-initiated wizard (`DesignImportDialog.tsx`) that fetches an
 * EXTERNAL GitHub repo or npm package by URL/name, previews classified
 * candidates, and lets the user pick which to apply. This module runs
 * AUTOMATICALLY against the CURRENTLY OPEN project's own CSS — no URL/
 * package entry, no preview step. The TRIGGERS stay separate (deliberately —
 * "a user explicitly importing from a named external source" is a different
 * UX moment than "the project I already opened"), but as of `infra-01` they
 * share ONE classification engine: `designImport/parseCssTokens.ts` calls
 * straight into `tokenExtractCssScan.ts`'s `classifyDeclaration`/
 * `resolveVarValue`/`collectRootScopeMaps`/`toPx` instead of carrying its own
 * separately-drifting, name-hint-first classifier. That old classifier never
 * resolved `var(...)` indirection ("meaningless as a standalone palette
 * entry"), which silently misclassified (or dropped) most of a real design
 * system's SEMANTIC color aliases (`--text-base-default: var(--color-metal)`
 * is a text COLOR, not a typography token) — exactly the failure mode this
 * module's value-first classification + `var()` resolution exist to avoid.
 * One engine, two triggers.
 */
import { join } from 'node:path'
import type { FrameworkSettings } from '@core/framework-schema'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir } from '../studioProjects'
import { readStudioFrameworkFile, writeStudioFrameworkFile } from '../studioFramework'
import { readCappedFile } from './styleCompileFileRead'
import { compileProjectStyles } from './styleCompile'
import { resolveProjectProfile } from './projectProbe'
import type { ProbeWarning, ProjectProfile } from './projectProfileSchema'
import { classifyCssText, hasAnyTokens, type ClassifiedTokens } from './tokenExtractCssScan'
import { extractTailwindThemeTokens } from './tokenExtractTailwind'
import { extractScssVariableTokens, findScssFileCandidates } from './tokenExtractScss'
import { extractJsThemeTokens, findJsThemeFileCandidates } from './tokenExtractJsTheme'
import { readInstalledPackageCss } from './tokenExtractPackageCss'
import { resolveAppRoot } from './appRoot'
import { buildFrameworkSettings, type ExtractedColorOrigin } from './tokenExtractBuild'

export type { ClassifiedTokens } from './tokenExtractCssScan'

// ---------------------------------------------------------------------------
// extractProjectTokens — the entry point
// ---------------------------------------------------------------------------

export type TokenExtractionSource = 'project-css' | 'tailwind-theme' | 'vendor-css' | 'scss-vars' | 'js-theme' | 'none'

export interface TokenExtractionCounts {
  colors: number
  spacing: number
  typography: number
}

export interface TokenExtractionResult {
  framework: FrameworkSettings
  source: TokenExtractionSource
  counts: TokenExtractionCounts
  /** Real typography declarations found but not representable as a size step (`tokenExtractBuild.ts`'s "Shape gap"). Surfaced as the `typography-detail-not-mapped` warning (with the count in its message), not a separate structured field. */
  warnings: ProbeWarning[]
}

function countTokens(tokens: ClassifiedTokens): TokenExtractionCounts {
  return { colors: tokens.colors.length, spacing: tokens.spacing.length, typography: tokens.typographySizes.length }
}

/**
 * `dir + ProjectProfile -> TokenExtractionResult`. Never throws: every source
 * degrades to an empty contribution (never a fabricated default), matching
 * `compileProjectStyles`'s own contract — a broken/missing source must not
 * block the rest of project load. Read-only: does not persist anything (the
 * caller decides whether/how to merge and write via `mergeExtractedFramework`
 * + `writeStudioFrameworkFile`).
 */
export async function extractProjectTokens(dir: string, profile: ProjectProfile): Promise<TokenExtractionResult> {
  const warnings: ProbeWarning[] = []
  const { styles: compiled, warnings: compileWarnings } = await compileProjectStyles(dir, profile)
  warnings.push(...compileWarnings)

  let tokens = classifyCssText(compiled.css)
  let source: TokenExtractionSource = 'project-css'

  if (!hasAnyTokens(tokens) && profile.styleToolchain.tailwind) {
    const configText = readCappedFile(join(dir, ...profile.styleToolchain.tailwind.configPath.split('/')))
    const tailwindTokens = configText ? extractTailwindThemeTokens(configText) : undefined
    if (tailwindTokens && hasAnyTokens(tailwindTokens)) {
      tokens = tailwindTokens
      source = 'tailwind-theme'
    }
  }

  if (!hasAnyTokens(tokens) && compiled.vendorCss) {
    const vendorTokens = classifyCssText(compiled.vendorCss)
    if (hasAnyTokens(vendorTokens)) {
      tokens = vendorTokens
      source = 'vendor-css'
    }
  }

  // T6 (STUDIO-FIGMA-PARITY-PLAN.md §11) — a Sass design system authored
  // purely in `$variables` (never re-exported as custom properties) and a
  // JS/TS theme object in the OPEN project both used to be invisible here,
  // even though the identical shapes were already handled elsewhere
  // (Tier-1 Sass compilation for the former; the external design-import
  // wizard for the latter). Tried last, in this order, because both are
  // Tier-0 TEXT scans of source files that may not agree with what actually
  // ships (an un-re-exported Sass variable, a theme object the app never
  // imports) — real signal, but weaker than something already reachable
  // through compiled/vendor CSS.
  if (!hasAnyTokens(tokens) && profile.styleToolchain.sass) {
    const scssFiles = findScssFileCandidates(dir)
    const combined = scssFiles.map((relPath) => readCappedFile(join(dir, ...relPath.split('/'))) ?? '').join('\n')
    const scssTokens = extractScssVariableTokens(combined)
    if (hasAnyTokens(scssTokens)) {
      tokens = scssTokens
      source = 'scss-vars'
    }
  }

  if (!hasAnyTokens(tokens)) {
    const jsThemeFiles = findJsThemeFileCandidates(dir)
    if (jsThemeFiles.length > 0) {
      const jsTokens = extractJsThemeTokens(dir, jsThemeFiles)
      if (hasAnyTokens(jsTokens)) {
        tokens = jsTokens
        source = 'js-theme'
      }
    }
  }

  // Last resort: the design system this project DEPENDS ON, read straight out
  // of `node_modules` even though no stylesheet from it is imported yet. A
  // freshly scaffolded project is exactly this shape — it declares and installs
  // a design system, and imports none of its CSS until someone writes the
  // import — so every source above legitimately found nothing while the whole
  // token set sat installed on disk. Tried last because anything the project
  // actually imports is a stronger statement of intent than something merely
  // present in `node_modules`.
  if (!hasAnyTokens(tokens) && profile.componentPackages.length > 0) {
    const installedCss = readInstalledPackageCss(resolveAppRoot(dir), profile.componentPackages)
    if (installedCss) {
      const installedTokens = classifyCssText(installedCss)
      if (hasAnyTokens(installedTokens)) {
        tokens = installedTokens
        // Same provenance the imported-vendor path reports: the Framework
        // panel renders this as "an installed design-system package", which is
        // precisely where these came from.
        source = 'vendor-css'
      }
    }
  }

  if (!hasAnyTokens(tokens)) {
    source = 'none'
    warnings.push({
      code: 'no-design-tokens-found',
      message: "No design tokens were found in this project's CSS custom properties, Tailwind theme, vendor package CSS, Sass $variables, or a conventionally-named theme file (theme/tokens/design-tokens/colors/palette).",
      fix: compiled.vendorCss === '' && compileWarnings.some((w) => w.code === 'vendor-css-requires-install')
        ? 'Run dependency install, then re-scan — this project imports a package stylesheet that has not been resolved yet.'
        : "Add design tokens as `:root` custom properties, or configure Tailwind's theme, then re-scan.",
    })
  }

  if (tokens.typographyDetailCount > 0) {
    warnings.push({
      code: 'typography-detail-not-mapped',
      message: `${tokens.typographyDetailCount} typography declaration(s) (font family/weight/line-height/letter-spacing) were found but Studio's typography model only represents a size scale — they were not imported.`,
      fix: 'Set font family/weight/line-height directly on the relevant elements or classes in the panel.',
    })
  }
  if (tokens.unclassifiedCount > 0) {
    warnings.push({
      code: 'unclassified-tokens-skipped',
      message: `${tokens.unclassifiedCount} custom propert${tokens.unclassifiedCount === 1 ? 'y' : 'ies'} could not be classified as a color, spacing, or typography-size value (e.g. gradients, radii, shadows) and were skipped rather than guessed.`,
      fix: 'No action needed — these are outside what the Framework panel represents today.',
    })
  }

  // `source === 'none'` only occurs when `tokens` has zero colors/spacing/
  // typography entries (`hasAnyTokens` failed for every attempted source),
  // so `buildColorTokens` never actually reads this placeholder value in
  // that branch — `'project-css'` here is a type-satisfying default, not a
  // real claim about provenance.
  const colorOrigin: ExtractedColorOrigin = source === 'none' ? 'project-css' : source
  return { framework: buildFrameworkSettings(tokens, colorOrigin), source, counts: countTokens(tokens), warnings }
}

// ---------------------------------------------------------------------------
// Merge — never clobber (see module doc)
// ---------------------------------------------------------------------------

const EMPTY_FRAMEWORK: FrameworkSettings = { colors: { tokens: [] } }

/**
 * Whole-family merge: a family (`colors`/`typography`/`spacing`) from
 * `extracted` is used ONLY when the corresponding family in `existing` is
 * absent or empty. The instant a family holds real data — whether a prior
 * extraction wrote it or the user authored it by hand in the panel — this
 * never touches it again. `preferences` is never touched by extraction.
 */
export function mergeExtractedFramework(
  existing: FrameworkSettings | null,
  extracted: FrameworkSettings,
): FrameworkSettings {
  const base = existing ?? EMPTY_FRAMEWORK
  const colors = base.colors.tokens.length > 0 ? base.colors : extracted.colors
  const typography = base.typography && base.typography.groups.length > 0 ? base.typography : extracted.typography
  const spacing = base.spacing && base.spacing.groups.length > 0 ? base.spacing : extracted.spacing
  return {
    colors,
    ...(typography ? { typography } : {}),
    ...(spacing ? { spacing } : {}),
    ...(base.preferences ? { preferences: base.preferences } : {}),
  }
}

// ---------------------------------------------------------------------------
// Route — GET/POST /admin/api/studio/tokens
// ---------------------------------------------------------------------------

const TokensBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

function resolveProfile(dir: string): ProjectProfile {
  return resolveProjectProfile(dir)
}

/**
 * `GET  /admin/api/studio/tokens?dir=<abs>` -> `{ source, counts, warnings }`.
 * Read-only preview: runs extraction but never writes `.studio/framework.json`
 * — same "GET never writes" contract `tryServeStudioProbe` follows.
 *
 * `POST /admin/api/studio/tokens  { dir }` -> `{ ok, framework, source,
 * counts, warnings }`. Runs extraction, merges it into whatever's already
 * persisted (`mergeExtractedFramework` — never clobbers), and writes through
 * `writeStudioFrameworkFile` so the existing `FrameworkSettingsSchema`
 * validation applies. Called on every `loadSite()` (so a fresh import gets
 * populated the first time it's opened, and a project whose tokens only
 * became reachable later — e.g. after "Install dependencies" — picks them up
 * on the next load) and from the panel's explicit "Re-scan tokens" action.
 */
export async function tryServeStudioTokens(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/tokens') return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const result = await extractProjectTokens(dir, resolveProfile(dir))
      return jsonResponse({ source: result.source, counts: result.counts, warnings: result.warnings })
    } catch (err) {
      console.error('[studio/tokenExtract]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, TokensBodySchema)
      if (!body) return badRequest('invalid tokens body')
      const dir = resolveProjectDir(body.dir)
      const result = await extractProjectTokens(dir, resolveProfile(dir))
      const merged = mergeExtractedFramework(readStudioFrameworkFile(dir), result.framework)
      const write = writeStudioFrameworkFile(dir, merged)
      if (!write.ok) return badRequest(write.message)
      return jsonResponse({
        ok: true,
        framework: write.value,
        source: result.source,
        counts: result.counts,
        warnings: result.warnings,
      })
    } catch (err) {
      console.error('[studio/tokenExtract]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
