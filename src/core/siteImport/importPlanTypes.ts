/**
 * Site-import pipeline types (Phase 2) for the Super Import pipeline.
 *
 * These types describe the whole-input plan assembled from the per-file
 * Phase 1 output (`cssImportTypes.ts`): file classification, page planning,
 * conflict detection, the fully-analysed `ImportPlan`, and the committed
 * `ImportResult`.
 *
 * Headless — no admin/React/server imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

import type { ConditionDef } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type {
  NewStyleRule,
  ImportWarning,
  ImportFontFamily,
  ImportGoogleFont,
  ImportColorToken,
  ImportFontToken,
  ImportScript,
  LinkedStylesheet,
  ImportStylesheet,
  PageScript,
} from './cssImportTypes'

// ---------------------------------------------------------------------------
// Phase 2 — Site-import pipeline types
// ---------------------------------------------------------------------------

/**
 * A normalized map of all files in the import input.
 *
 * Keys are relative paths with `/` separators (no leading `./` or `/`).
 * Produced by `ingestInput.ts` from any of the four input shapes.
 */
export interface FileMap {
  /** All files keyed by normalized relative path. */
  files: Record<string, { bytes: Uint8Array; mimeType?: string }>
  /**
   * When unpacking a ZIP whose every entry shared a single top-level folder,
   * that folder name is recorded here so consumers can surface it in the UI.
   * Undefined when no strip happened.
   */
  strippedTopLevelFolder?: string
}

/**
 * The semantic role of a file in the import.
 * Used by `classifyFiles` to decide how each file is processed.
 */
export type FileRole = 'html' | 'css' | 'js' | 'image' | 'font' | 'binary' | 'meta'

/** A single file with its resolved role and raw bytes. */
export interface ClassifiedFile {
  /** Normalized relative path (FileMap key). */
  path: string
  role: FileRole
  size: number
  bytes: Uint8Array
  mimeType?: string
}

/**
 * A single HTML file processed into a page-ready plan.
 *
 * `nodeFragment` contains the parsed body content. Class names inside the
 * fragment are still raw name strings; the admin-side adapter resolves them
 * into registry ids when calling `addPage`.
 */
export interface PagePlan {
  /** FileMap key of the source HTML file. */
  source: string
  /** Display title derived from `<title>` or prettified filename. */
  title: string
  /** URL-safe slug derived from the filename. */
  slug: string
  /**
   * FileMap keys of CSS files linked by `<link rel="stylesheet">` in the
   * page's `<head>`, expanded to include unconditional local CSS `@import`
   * dependencies. Only paths that exist in the FileMap are included; missing
   * hrefs/imports produce `missing-stylesheet` warnings instead.
   */
  linkedCssPaths: string[]
  /**
   * Executable JavaScript tags in source order. External entries only include
   * paths that exist in the FileMap; missing hrefs produce `missing-script`
   * warnings instead. Non-executable script data (`application/json`,
   * import maps, templates, etc.) is intentionally skipped.
   */
  scripts: PageScript[]
  /**
   * The body content as a flat node fragment.
   *
   * URL-shaped props (`src`, `href`, `srcset`) are normalized to FileMap keys
   * (relative paths) so that `applyAssetRewrites` can do exact-string
   * replacement without needing the original base path.
   */
  nodeFragment: ImportFragment
}

/** How a slug, rule-name, or token-variable conflict is resolved for a single item. */
export interface ConflictResolution {
  action: 'auto-rename' | 'overwrite' | 'skip' | 'custom-rename'
  /** Resolved slug (for page conflicts; defined when action !== 'skip'). */
  resolvedSlug?: string
  /** Resolved name (for rule conflicts; defined when action !== 'skip'). */
  resolvedName?: string
  /**
   * Resolved CSS custom-property name without leading `--` (for token conflicts;
   * defined when action is `auto-rename` or `custom-rename`).
   */
  resolvedVariable?: string
}

/** A page slug that collides with an existing page. */
export interface PageConflict {
  /** FileMap key of the HTML source file. */
  source: string
  /** The slug the importer wanted to use. */
  desiredSlug: string
  /** ID of the existing page that owns the slug. */
  existingPageId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A `kind:'class'` rule name that collides with an existing class rule.
 *
 * Ambient rules NEVER conflict — multiple ambient rules with the same
 * selector are allowed; cascade resolves by `order`.
 */
export interface RuleConflict {
  /** FileMap key of the CSS source file (or empty if unknown). */
  source: string
  /** The class name the importer wanted to use. */
  desiredName: string
  /** ID of the existing StyleRule that owns the name. */
  existingRuleId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * One divergent cross-sheet definition of a class name among CONVERTED
 * stylesheets: two page cascades define the same class with different
 * effective declarations. The first-encountered definition keeps the bare
 * name; each later distinct definition raises one conflict.
 *
 * Resolutions (applied by `applyCrossSheetClassResolutions`):
 * - `auto-rename` / `custom-rename` (default): this definition moves to
 *   `resolvedName` — its pages' class tokens and its cascade's selectors
 *   follow, so every page keeps rendering with its own styles.
 * - `skip`: drop this definition; its pages bind to the first definition.
 * - `overwrite`: this definition wins the bare name; the other definitions'
 *   class fragments are dropped and their pages bind to this one.
 */
export interface CrossSheetClassConflict {
  /** The colliding class name as authored in the source CSS. */
  desiredName: string
  /** Stable id of this divergent definition (hash of its effective declarations). */
  definitionId: string
  /**
   * CSS file paths whose class fragments produce this definition and are not
   * shared with the kept (first) definition's cascades.
   */
  sources: string[]
  /** HTML page sources rendered with this definition. */
  pageSources: string[]
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A design-token CSS custom property (`--bg`, `--font-primary`) extracted from
 * the import that collides with an existing token in the site.
 *
 * Both colour tokens (keyed by `--<slug>`) and font tokens (keyed by
 * `--font-*`) are modelled here: they are the same thing — a `--var` contract
 * referenced by `var(--x)` in the imported CSS — and resolve through one UI.
 *
 * `auto-rename` / `custom-rename` rename the imported token AND rewrite every
 * `var(--old)` reference in the imported style rules and node inline styles to
 * the new name, so the imported design stays faithful. `skip` keeps the
 * existing token (imported `var(--x)` binds to it). `overwrite` replaces the
 * existing token's value, keeping its name so both sides keep resolving.
 */
export interface TokenConflict {
  /** Which registry the token lives in. */
  kind: 'color' | 'font'
  /**
   * The CSS custom-property name without the leading `--` the importer wanted
   * (e.g. `bg` for `--bg`, `font-primary` for `--font-primary`).
   */
  desiredVariable: string
  /** ID of the existing token (framework colour / font token) that owns the name. */
  existingTokenId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * The fully-analysed import plan.
 *
 * Produced by `buildImportPlan`. Consumed by `commitImportPlan` (which calls
 * the adapter) and by the Phase 3 wizard UI (for preview and conflict
 * resolution).
 *
 * All URL-shaped values inside `pages[].nodeFragment` and
 * `styleRules[].styles` / `contextStyles` are normalized to FileMap keys
 * so that `applyAssetRewrites` can replace them with new media URLs.
 */
export interface ImportPlan {
  pages: PagePlan[]
  styleRules: NewStyleRule[]
  /**
   * Index-aligned with `styleRules`: the FileMap key of the source stylesheet
   * each rule was parsed from (a real `.css` path, or a synthetic
   * `<htmlPath>::inline` key for an inline `<style>` block). Import-time
   * metadata only — used by the wizard to group rules by source stylesheet.
   * NOT persisted onto the committed `StyleRule`.
   */
  styleRuleSources: string[]
  /**
   * Custom font families synthesized from imported `@font-face` blocks. Each
   * file's `src` is a FileMap key here; `applyAssetRewrites` rewrites it to the
   * uploaded media URL, then `commitImportPlan` assembles a `FontEntry`.
   */
  fonts: ImportFontFamily[]
  /**
   * Google font families extracted from trusted CSS2 `@import` rules. Commit
   * installs these into `site.settings.fonts.items` through the normal CMS
   * Google-font installer before font tokens are added.
   */
  googleFonts: ImportGoogleFont[]
  /**
   * Reusable site-level conditions referenced by `styleRules[].contextStyles`
   * keys (custom @media / @container / @supports). Merged into `site.conditions`
   * on commit.
   */
  conditions: ConditionDef[]
  /** Assets to upload, with their raw bytes. */
  assets: { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  /**
   * Colour-valued custom properties pulled from root-scope rules, ready to
   * commit into the CMS colours system. Deduped by slug across all CSS files.
   */
  colors: ImportColorToken[]
  /**
   * Root `--font-*` variables pulled from imported CSS, ready to commit into
   * `site.settings.fonts.tokens`.
   */
  fontTokens: ImportFontToken[]
  /**
   * JavaScript files linked by imported pages, committed as page-scoped site
   * scripts. Unlinked JS files stay as imported media assets instead of being
   * executed.
   */
  scripts: ImportScript[]
  /**
   * Every top-level stylesheet linked by ≥1 imported page, with the import
   * mode this plan was built with. Drives the wizard's per-sheet mode picker.
   */
  linkedStylesheets: LinkedStylesheet[]
  /** Stylesheets kept as files (`mode: 'file'`), ready to commit as SiteFiles. */
  stylesheets: ImportStylesheet[]
  conflicts: {
    pages: PageConflict[]
    rules: RuleConflict[]
    tokens: TokenConflict[]
    /** Divergent cross-sheet class definitions among CONVERTED stylesheets. */
    crossSheetClasses: CrossSheetClassConflict[]
  }
  warnings: ImportWarning[]
  /**
   * Source text snippets of @-rules that could not be modelled
   * (from `dropped-at-rule` warnings in the CSS parser).
   */
  droppedAtRules: string[]
  /** CSS files present in the FileMap but not linked by any imported page. */
  unusedCss: string[]
}

/**
 * The committed result of applying an ImportPlan through a SiteImportAdapter.
 *
 * Returned by `commitImportPlan`. Provides enough information for the
 * Phase 3 wizard's "Done" step to show a summary.
 */
export interface ImportResult {
  pages: { id: string; title: string; slug: string; source: string }[]
  styleRules: { id: string; selector: string; kind: 'class' | 'ambient' }[]
  /** Fonts imported into the installed font library. */
  fonts: { id: string; family: string }[]
  assets: { sourcePath: string; mediaUrl: string }[]
  /** Colour tokens committed into the framework colours system. */
  colors: { slug: string; value: string }[]
  /** Font tokens committed into `site.settings.fonts.tokens`. */
  fontTokens: { id: string; name: string; variable: string }[]
  /** Site scripts committed from imported JS files. */
  scripts: { id: string; path: string }[]
  /** Stylesheets committed as page-scoped SiteFiles (`mode: 'file'`). */
  stylesheets: { id: string; path: string }[]
  /** Resolved conflicts (mirrors ImportPlan.conflicts with final actions). */
  conflicts: ImportPlan['conflicts']
  warnings: ImportWarning[]
}
