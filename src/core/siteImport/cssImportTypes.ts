/**
 * CSS-import types for the Super Import pipeline (Phase 1).
 *
 * These are the types produced while parsing a stylesheet in isolation —
 * style rules, warnings, breakpoint/asset/font extraction — before Phase 2
 * (`importPlanTypes.ts`) assembles them, across every file in the input,
 * into one `ImportPlan`.
 *
 * Headless — no admin/React/server imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

import type { StyleRule } from '@core/page-tree'
import type { FontFileFormat } from '@core/fonts'
import type { SiteScriptFormat } from '@core/site-runtime'

// ---------------------------------------------------------------------------
// NewStyleRule — a StyleRule ready to insert (sans identity fields)
// ---------------------------------------------------------------------------

/**
 * A fully-specified style rule that can be committed to the site's styleRules
 * registry. The identity fields (`id`, `createdAt`, `updatedAt`) are assigned
 * by the caller (Phase 2's `applyImport.ts`) when writing to the store, not
 * by the parser.
 */
export type NewStyleRule = Omit<StyleRule, 'id' | 'createdAt' | 'updatedAt'>

// ---------------------------------------------------------------------------
// ImportWarning
// ---------------------------------------------------------------------------

/**
 * Categories of warnings that the import pipeline can emit.
 *
 * Phase 1 (CSS parser) kinds:
 * - `dropped-at-rule`: an @-rule that the engine can't model was silently
 *   dropped (@page, @namespace, @layer, etc.). `@keyframes`, `@font-face`,
 *   `@supports`, and `@container` are imported through dedicated paths.
 * - `unmatched-media-query`: an @media query that could not be matched to any
 *   defined viewport context. Inner declarations are still imported under a
 *   reusable media condition so nothing is silently lost.
 * - `invalid-rule`: a rule that the CSS engine rejected (typically a sheet-
 *   level parse error that causes `replaceSync` to throw).
 * - `unknown-property`: legacy — retained for back-compat with any persisted
 *   warnings. The Phase 1a permissive property model no longer emits this; a
 *   declaration is only dropped when its NAME is denied (see
 *   `blocked-property`), not when it's merely uncurated.
 * - `blocked-property`: a CSS declaration whose property name is on the
 *   security denylist (`behavior`, `-moz-binding`, …). Rare. The declaration
 *   is dropped from the rule.
 * - `asset-reference`: informational — a `url(...)` payload was found in a
 *   declaration value. Assets are collected in `assetRefs` (not warnings) by
 *   the Phase 1 parser; this kind is reserved for Phase 2's use.
 * - `duplicate-class`: two `.foo { ... }` rules with the same class selector
 *   appeared in the same file. The later rule's declarations win (CSS cascade
 *   semantics). One warning is emitted per duplicated class.
 *
 * Phase 2 (site import pipeline) kinds:
 * - `missing-stylesheet`: a stylesheet referenced from an HTML `<link>` or a
 *   local CSS `@import` was not found in the FileMap. The page is still
 *   imported; the missing CSS is noted but not fatal.
 * - `missing-script`: a `<script src>` referenced in an HTML file was not
 *   found in the FileMap. The page is still imported; the missing script is
 *   noted but not fatal.
 * - `asset-upload-failed`: an individual asset upload was rejected by the
 *   media library (e.g. unsupported MIME, oversized file, server error).
 *   The remaining assets continue to upload; the failed file is left
 *   referenced in the source HTML/CSS by its original FileMap path so the
 *   import doesn't degrade pages or rules. Surface the warning in the
 *   wizard's Done step so the user can re-upload manually.
 * - `font-install-failed`: a Google Fonts CSS2 import was understood, but the
 *   CMS Google-font installer could not download/register the self-hosted
 *   files. The import continues; affected font tokens fall back to their
 *   authored fallback stacks.
 * - `external-font`: an `@font-face` whose every `src` is an external URL
 *   (or `local(...)` only) — nothing to upload, so the face is skipped rather
 *   than imported. The user can re-add the font by hand. Self-hosted faces
 *   (a bundled `.woff2`/`.woff`/`.ttf`/`.otf`) ARE imported as custom fonts.
 */
type ImportWarningKind =
  | 'dropped-at-rule'
  | 'unmatched-media-query'
  | 'invalid-rule'
  | 'unknown-property'
  | 'blocked-property'
  | 'asset-reference'
  | 'duplicate-class'
  | 'missing-stylesheet'
  | 'missing-script'
  | 'asset-upload-failed'
  | 'font-install-failed'
  | 'external-font'

export interface ImportWarning {
  kind: ImportWarningKind
  /** Human-readable description of what was dropped or why. */
  message: string
  /**
   * For CSS warnings: the raw CSS source text that triggered the warning,
   * truncated to ~120 chars with a trailing `…` if cut.
   * For `missing-stylesheet`: the HTML/CSS file that referenced the missing CSS.
   */
  source?: string
  /** The CSS selector relevant to the warning (for unknown-property, duplicate-class). */
  selector?: string
  /** The camelCase property name (for unknown-property warnings). */
  property?: string
  /**
   * File path relevant to the warning (for `missing-stylesheet`: the unresolved
   * CSS href as it appeared in the HTML source).
   */
  path?: string
}

// ---------------------------------------------------------------------------
// BreakpointHint — how @media queries map to named viewport contexts
// ---------------------------------------------------------------------------

/**
 * A hint that maps a named viewport context to its CSS media query and pixel
 * frame width. Passed to `cssToStyleRules` so @media queries can be matched to
 * existing site viewport contexts by configured query first, then by
 * max-width threshold (±mediaTolerance) for older/default contexts.
 */
export interface BreakpointHint {
  /** Viewport context identifier, matching a context key used in `StyleRule.contextStyles`. */
  id: string
  /** The frame width in CSS pixels (e.g. 768 for a tablet viewport). */
  width: number
  /** The configured CSS media query for this viewport context. */
  mediaQuery?: string
}

// ---------------------------------------------------------------------------
// AssetRef — records a url(...) reference found in an imported rule
// ---------------------------------------------------------------------------

/**
 * A URL reference found inside a CSS declaration value.
 *
 * The parser records these but does NOT modify the rule's declaration value.
 * Phase 2 (`applyImport.ts`) rewrites the URLs once assets have been uploaded
 * and their final media-library paths are known.
 *
 * NOTE: Only references inside emitted or captured rules are recorded. A
 * `url()` inside a dropped @-rule does not appear in `assetRefs` because the
 * rule was never emitted.
 */
export interface AssetRef {
  /** Zero-based index into `CssToStyleRulesResult.rules`. */
  ruleIndex: number
  /**
   * The editing-context id this declaration lives in (a viewport context id or
   * a custom-condition id — both keys into `StyleRule.contextStyles`), or
   * `undefined` for the rule's base `styles` object. When set, the rewriters
   * target that context's override bag rather than base.
   */
  contextId?: string
  /** True when the reference lives inside a rule's `rawCss` block. */
  rawCss?: boolean
  /** camelCase CSS property name (e.g. `backgroundImage`). */
  property: string
  /**
   * The raw URL payload — unquoted and untrimmed. For `url('assets/bg.png')`
   * this is `assets/bg.png`.
   */
  rawUrl: string
}

// ---------------------------------------------------------------------------
// @font-face import types
// ---------------------------------------------------------------------------

/**
 * One `@font-face` block captured verbatim by the CSS parser, before asset
 * resolution. `srcUrls` are the raw `url(...)` payloads (a single face may list
 * several fallback formats); `variant` is the canonical weight/style derived
 * from the `font-weight` + `font-style` descriptors.
 */
export interface ParsedFontFace {
  family: string
  /** Canonical variant tag — "400", "700italic", … */
  variant: string
  /** Raw `url(...)` payloads from the `src` descriptor, in source order. */
  srcUrls: string[]
  unicodeRange?: string
}

/**
 * One resolved font file ready to become a `FontFile`. `src` holds a FileMap
 * key before `applyAssetRewrites` runs, and the rewritten media URL after.
 */
export interface ImportFontFile {
  variant: string
  format: FontFileFormat
  /** FileMap key (pre-rewrite) → media public URL (post-rewrite). */
  src: string
  unicodeRange?: string
}

/** A custom font family synthesized from imported `@font-face` blocks. */
export interface ImportFontFamily {
  family: string
  files: ImportFontFile[]
}

/**
 * A Google Fonts CSS2 family request extracted from a trusted
 * `fonts.googleapis.com/css2` @import. Commit resolves these through the same
 * CMS Google-font installer used by the Typography panel, producing self-hosted
 * font entries instead of leaving an external stylesheet in the site.
 */
export interface ImportGoogleFont {
  family: string
  variants: string[]
  subsets: string[]
}

/**
 * A colour-valued custom property pulled from a root-scope rule (`:root`,
 * `html`, `body`). Committed into the CMS colours system
 * (`site.settings.framework.colors`) as a plain base token that re-emits
 * `--<slug>`. See `colorTokens.ts`.
 */
export interface ImportColorToken {
  /** CSS-variable name without the leading `--` (e.g. `bg`). */
  slug: string
  /** The authored colour value, verbatim and trimmed (e.g. `#0a0a0a`). */
  value: string
  /**
   * The resolved dark-mode value, when the source declares one that
   * genuinely differs from `value`. Optional and producer-dependent — not
   * every `ImportColorToken` source resolves a dark counterpart.
   */
  dark?: string
}

/**
 * A root-scope `--font-*` custom property pulled from imported CSS. Committed
 * into `site.settings.fonts.tokens` so `font-family: var(--font-primary)` keeps
 * resolving through the builder's editable font-token model.
 */
export interface ImportFontToken {
  /** User-facing token name derived from the variable, e.g. `font-display` → `Display`. */
  name: string
  /** CSS-variable name without leading dashes, normalized to `font-*`. */
  variable: string
  /** First concrete family in the source stack, if present. */
  family?: string
  /** Remaining fallback stack, or the whole stack for system/generic tokens. */
  fallback: string
}

/**
 * An npm package required by an imported runtime module script.
 *
 * Super Import derives these when a source script imports an ESM CDN URL that
 * maps cleanly to an npm package, then rewrites that import to the bare package
 * specifier so the normal self-hosted dependency resolver can install it.
 */
export interface ImportScriptDependency {
  name: string
  version: string
}

/**
 * A JavaScript file linked by one or more imported HTML pages. Committed as a
 * `SiteFile` (`type: 'script'`) plus page-scoped `site.runtime.scripts` entry.
 * `content` is the decoded UTF-8 source.
 */
export interface ImportScript {
  /** FileMap path of the source file (e.g. `scripts/app.js`). */
  path: string
  /** Decoded UTF-8 JavaScript source. */
  content: string
  /** Loader semantics from the source HTML. Classic scripts bypass bundling. */
  format: SiteScriptFormat
  /** HTML FileMap sources that linked this script. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /** Runtime ordering; lower runs earlier. Derived from first HTML occurrence. */
  priority: number
  /** npm dependencies needed by this module script after import conversion. */
  dependencies?: ImportScriptDependency[]
}

/**
 * How one top-level linked stylesheet imports.
 *
 * - `'convert'` (default): the sheet is parsed into editable style rules —
 *   class rules become registry classes, ambient rules, `@keyframes`, colour /
 *   font token extraction. Converted rules merge into the site's one global
 *   cascade, CSS-natively.
 * - `'file'`: the sheet's CSS text imports verbatim (minus asset-URL
 *   rewriting) as a `SiteFile` (`type: 'style'`) scoped to exactly the pages
 *   that linked it via `site.runtime.styles`. No selector rewriting, no
 *   generated scope classes — the file is the single source of truth, so
 *   semantic extraction (rules, tokens, keyframes) is skipped for it.
 */
export type StylesheetImportMode = 'convert' | 'file'

/**
 * One top-level stylesheet linked by ≥1 imported page, as presented in the
 * wizard's Review step. `mode` reflects the caller-chosen import mode this
 * plan was built with (default `'convert'`).
 */
export interface LinkedStylesheet {
  /** FileMap path of the `<link rel="stylesheet">` target. */
  path: string
  mode: StylesheetImportMode
  /** HTML FileMap sources that link this stylesheet. */
  pageSources: string[]
}

/**
 * A stylesheet kept as a file (`mode: 'file'`). Committed as a `SiteFile`
 * (`type: 'style'`) plus a page-scoped `site.runtime.styles` entry, exactly
 * like imported scripts. `content` is the flattened CSS: the sheet's
 * unconditional local `@import` graph inlined in cascade order, trusted
 * Google-font `@import`s stripped (they install as self-hosted fonts), and
 * `url(...)` payloads normalised to FileMap keys for asset rewriting.
 */
export interface ImportStylesheet {
  /** FileMap path of the source file (e.g. `css/style.css`). */
  path: string
  /** Flattened CSS text. */
  content: string
  /** HTML FileMap sources that linked this stylesheet. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /** Cascade ordering within the user-stylesheet bundle; lower applies earlier. */
  priority: number
}

/**
 * A script tag discovered while planning one HTML page, preserving source
 * order across inline executable JavaScript and external `<script src>` tags.
 */
export type PageScript =
  | {
    kind: 'external'
    /** FileMap path of the linked JavaScript file. */
    path: string
    /** Loader semantics from the source HTML. */
    format: SiteScriptFormat
  }
  | {
    kind: 'inline'
    /** Stable synthetic SiteFile path derived from the source HTML file. */
    path: string
    /** Inline JavaScript source. */
    content: string
    /** Loader semantics from the source HTML. */
    format: SiteScriptFormat
  }
