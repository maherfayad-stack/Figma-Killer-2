/**
 * designImport/parseCssTokens — hand-rolled scanning for design-token import,
 * across three source shapes:
 *   - CSS: `:root`/global-token-host custom properties, `var()`-resolved and
 *     classified through `tokenExtractCssScan.ts`'s shared engine (see below)
 *     — see `buildCssCandidates`.
 *   - JSON: a recursive walk of the parsed value (real JSON.parse — always
 *     safe) — see `extractJsonTokens`.
 *   - JS/TS: a conservative TEXT-ONLY regex over `key: 'quoted string'` pairs
 *     — the source is NEVER parsed as code or executed — see
 *     `extractJsTokens`.
 *
 * ## One classification engine, not two
 *
 * This module used to carry its own `classifyToken` — a NAME-hint-first
 * heuristic (`--text-*` reads as typography by name) that never resolved
 * `var(...)` indirection ("meaningless as a standalone palette entry"). That
 * was a real, documented correctness gap: most of a real design system's
 * semantic palette IS `var()` indirection (`--text-base-default: var(--color-
 * metal)` is a text COLOR, not a typography token), and name-first
 * classification got both wrong — it forced the alias to typography by name,
 * AND never had a value to fall back on since it was never resolved.
 *
 * `server/handlers/studio/tokenExtractCssScan.ts` (built for `tokens-01`'s
 * automatic, currently-open-project import) already solved this correctly:
 * value-first classification (a real color literal is a color regardless of
 * name) with bounded, cycle-safe `var()` resolution against the same `:root`
 * scope. Rather than duplicate that engine a second time for this
 * WIZARD-triggered, external-source import, this module now calls it
 * directly (`classifyDeclaration`, `resolveVarValue`, `collectRootScopeMaps`,
 * `toPx`) for BOTH the CSS path (with real resolution) and the JSON/JS path
 * (classifying the extracted name/value pair with no resolution to do — a
 * JSON/JS token file's leaves are ordinarily literal, not `var()` refs). One
 * engine, two triggers (automatic vs. manual/external), per CLAUDE.md's
 * "no old and new side by side."
 *
 * Scope, deliberately narrow:
 *   - Only declared CUSTOM PROPERTIES inside a recognized global-token-host
 *     selector are extracted — see `tokenExtractCssScan.ts`'s
 *     `isGlobalTokenHostSelector` (`:root`, `html`, `body`, or any of those
 *     wrapped in a single `:where(...)`/`:is(...)` — open-props ships every
 *     token under `:where(html)` rather than `:root`) — not arbitrary
 *     color/length literals scattered through ordinary rules. Third-party CSS
 *     is unpredictable; custom properties on a recognized host are the
 *     closest thing to a declared "design token" a stylesheet can have, so
 *     restricting to them keeps the signal high.
 *   - `@font-face` family names are NOT extracted as a token category: this
 *     app's Framework "Typography" settings are a numeric font-SIZE scale
 *     (`FrameworkTypographyGroup`), not a font-family picker — that's a
 *     separate subsystem (`@core/fonts`). Any `@font-face` rules in the
 *     source CSS still work because the raw file is copied into the project
 *     verbatim; they're just not surfaced as importable "typography" tokens.
 */
import {
  classifyDeclaration,
  collectRootScopeMaps,
  resolveVarValue,
  toPx,
  type Classification,
} from '../studio/tokenExtractCssScan'

export interface ExtractedCssVar {
  /** Custom property name, without the leading `--`. */
  name: string
  /** Raw declared value, as written in the source (e.g. `"#4f46e5"`, `"1.25rem"`). */
  value: string
  /** Which source file this came from — surfaced in the preview for context. */
  file: string
}

export type TokenCategory = 'color' | 'typography' | 'spacing' | 'other'

/** One classified color candidate — ready for `createFrameworkColorToken`. */
export interface ColorTokenCandidate {
  id: string
  name: string
  value: string
  file: string
}

/**
 * One classified size candidate (typography or spacing) — ready for a
 * `fluid_manual` scale group's `manualSizes` entry. `px` is the value
 * converted to a plain number of pixels (`toPx`); size candidates whose unit
 * can't be safely converted (`%`, `vh`, `ch`, …) are excluded from these
 * lists entirely, not included with a guessed value.
 */
export interface SizeTokenCandidate {
  id: string
  name: string
  value: string
  px: number
  file: string
}

export interface TokenCandidates {
  colors: ColorTokenCandidate[]
  typography: SizeTokenCandidate[]
  spacing: SizeTokenCandidate[]
  /** Declared custom properties that didn't classify into any of the above — informational only, never applied. */
  otherCount: number
}

/** `classifyDeclaration`'s 5-way `Classification` collapsed to this module's 4-way `TokenCategory` — `typography-detail` (real, but not representable as a size step) and `unclassified` both surface as `'other'`, matching this wizard's existing preview shape (no separate "detail" bucket in `DesignImportDialog.tsx`). */
function toTokenCategory(kind: Classification): TokenCategory {
  if (kind === 'color') return 'color'
  if (kind === 'spacing') return 'spacing'
  if (kind === 'typography-size') return 'typography'
  return 'other'
}

// ---------------------------------------------------------------------------
// :root custom-property extraction (delegates to the shared engine)
// ---------------------------------------------------------------------------

/**
 * Drops the leading `--` from a CSS custom-property name, producing this
 * module's public token IDENTITY (see `ExtractedCssVar.name`).
 *
 * The shared engine keys its scope maps by the RAW `--name` because there it
 * is a map key that `var(--x)` references must match exactly. That is an
 * internal detail of resolution, and it stops at this boundary: `--` is CSS
 * *syntax*, re-added at emission time by `@core/framework`'s
 * `convertToVariableDeclarationName`, exactly the way a `.` is re-added to a
 * class name. Carrying it in the identity double-prefixes every consumer —
 * `DesignImportDialog` renders `--{c.name}`, and the bare form is also the
 * only convention the CSS, JSON, and JS/TS sources can share in one preview
 * list (a JSON file's `{"space-md": …}` leaf has no `--` to begin with).
 */
function bareTokenName(name: string): string {
  return name.replace(/^--/, '')
}

/** Extracts every classifiable `--name: value;` declaration from every global-token-host block in `css` (see module doc), `var()`-resolved against `css`'s own root scope. Exported for its own test coverage; `buildTokenCandidates` is the real entry point. */
export function extractRootCustomProperties(css: string, file: string): ExtractedCssVar[] {
  const { light } = collectRootScopeMaps(css)
  const out: ExtractedCssVar[] = []
  for (const [name, raw] of light) {
    out.push({ name: bareTokenName(name), value: resolveVarValue(raw, light), file })
  }
  return out
}

// ---------------------------------------------------------------------------
// Classification — a thin, name-preserving wrapper around the shared engine
// ---------------------------------------------------------------------------

/**
 * Classifies one already-resolved `name: value` pair via the shared
 * `classifyDeclaration` engine (value first, name-hint second, never guesses
 * a bare length into spacing with no hint at all — see that function's doc).
 * Kept as a named export (rather than inlining `classifyDeclaration` at each
 * call site) purely for this module's own test coverage and because callers
 * here want the 4-way `TokenCategory`, not the engine's 5-way
 * `Classification`.
 */
export function classifyToken(name: string, value: string): TokenCategory {
  return toTokenCategory(classifyDeclaration(name, value.trim()))
}

// ---------------------------------------------------------------------------
// JSON token extraction
// ---------------------------------------------------------------------------

/**
 * True for a DTCG-ish ("Design Tokens Community Group") leaf object —
 * `{ "value": "#fff", "type": "color" }` — the de-facto convention most
 * JSON token files (Style Dictionary, Tokens Studio, …) use instead of a
 * bare literal.
 */
function isDtcgLeaf(value: unknown): value is { value: string | number; type?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = (value as Record<string, unknown>).value
  return typeof v === 'string' || typeof v === 'number'
}

/**
 * Recursively walks a parsed JSON value, collecting every string/number leaf
 * as a candidate token — `name` is the dot-joined path (e.g.
 * `colors.brand.500`), which then runs through the SAME `classifyDeclaration`
 * heuristic as a CSS custom property name. A DTCG-style `{value, type}` leaf
 * folds its `type` into the classified name (e.g. `color colors.brand.500`)
 * so a file that already declares "this is a color" gets that signal too,
 * without inventing a parallel type-hint system.
 */
export function extractJsonTokens(value: unknown, file: string, path: string[] = []): ExtractedCssVar[] {
  if (isDtcgLeaf(value)) {
    const name = [value.type, ...path].filter(Boolean).join(' ')
    return [{ name, value: String(value.value), file }]
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return path.length === 0 ? [] : [{ name: path.join('.'), value: String(value), file }]
  }
  if (Array.isArray(value)) return [] // token files don't meaningfully nest into arrays
  if (typeof value === 'object' && value !== null) {
    const out: ExtractedCssVar[] = []
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...extractJsonTokens(child, file, [...path, key]))
    }
    return out
  }
  return []
}

// ---------------------------------------------------------------------------
// JS/TS token extraction (text-only — the source is never parsed as code,
// let alone executed)
// ---------------------------------------------------------------------------

/**
 * Strips `//` line comments and `/* … *\/` block comments from JS/TS source.
 * Deliberately simple (doesn't understand string literals containing `//`)
 * — acceptable here because the only thing this feeds into is a regex
 * looking for quoted string VALUES; a `//` inside a string just shortens
 * that one match's scan window, it doesn't corrupt anything else.
 */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const JS_STRING_ENTRY_RE = /(?:^|[{,])\s*(?:['"]?)([A-Za-z0-9_$-]+)(?:['"]?)\s*:\s*(['"])((?:(?!\2)[^\\\n]|\\.)*)\2/g

/**
 * Extracts `key: 'string value'` / `key: "string value"` pairs from JS/TS
 * source text — NOT a JS parser, and the source is never evaluated. This
 * only recognizes the simplest, most common token-file shape: a flat or
 * nested plain-object literal whose leaves are quoted strings (colors,
 * dimensions with units, font stacks). Computed keys, template literals,
 * spreads, and non-string (numeric/expression) values are not extracted —
 * acceptable because `classifyDeclaration` still filters the result: a match
 * on unrelated code (e.g. `className: 'foo'`) simply won't look like a color
 * or length and lands in "other", same safety net the CSS path relies on.
 */
export function extractJsTokens(source: string, file: string): ExtractedCssVar[] {
  const cleaned = stripJsComments(source)
  const out: ExtractedCssVar[] = []
  let match: RegExpExecArray | null
  JS_STRING_ENTRY_RE.lastIndex = 0
  while ((match = JS_STRING_ENTRY_RE.exec(cleaned)) !== null) {
    out.push({ name: match[1], value: match[3].trim(), file })
  }
  return out
}

// ---------------------------------------------------------------------------
// Aggregate candidate list across every fetched file
// ---------------------------------------------------------------------------

let candidateIdCounter = 0
function nextCandidateId(): string {
  candidateIdCounter += 1
  return `design-import-${Date.now()}-${candidateIdCounter}`
}

/**
 * CSS files are concatenated (in order) into ONE text before scanning — a
 * design-token repo commonly splits `colors.css`/`spacing.css` referencing a
 * shared `variables.css`, and `var()` resolution needs to see all of it at
 * once, the same way `tokenExtract.ts` resolves against a whole project's
 * already-concatenated compiled CSS. `file` attribution (which of the
 * ORIGINAL files a given name came from, for the preview) is tracked
 * separately, per-file, with the same "later file wins" cascade order the
 * combined map already resolves duplicates by.
 */
function buildCssCandidates(cssFiles: ReadonlyArray<{ relPath: string; contents: string }>): ExtractedCssVar[] {
  if (cssFiles.length === 0) return []
  const combined = cssFiles.map((f) => f.contents).join('\n')
  const { light } = collectRootScopeMaps(combined)

  const nameToFile = new Map<string, string>()
  for (const file of cssFiles) {
    for (const name of collectRootScopeMaps(file.contents).light.keys()) {
      nameToFile.set(name, file.relPath)
    }
  }

  // `light` and `nameToFile` are both keyed by the RAW `--name` (that is what
  // `var()` resolution has to match); the `--` is dropped only on the way out.
  const out: ExtractedCssVar[] = []
  for (const [name, raw] of light) {
    out.push({
      name: bareTokenName(name),
      value: resolveVarValue(raw, light),
      file: nameToFile.get(name) ?? cssFiles[0]!.relPath,
    })
  }
  return out
}

/**
 * Scans every fetched source file — CSS via its global-token-host custom
 * properties (`buildCssCandidates`), JSON/JS/TS token files
 * (`isCandidateTokenFile`) via their own extractors — classifies each
 * declaration through the shared `classifyDeclaration` engine, and returns
 * de-duplicated candidate lists (later files win on a `name` collision —
 * matches "last one wins" cascade intuition for same-named tokens across
 * multiple files). `cssFiles` and `tokenFiles` are scanned identically past
 * extraction; they're only kept apart upstream because CSS files are also
 * eligible for project copy-back and token files are not (see
 * `FetchedSource`'s doc).
 */
export function buildTokenCandidates(
  cssFiles: ReadonlyArray<{ relPath: string; contents: string }>,
  tokenFiles: ReadonlyArray<{ relPath: string; contents: string }> = [],
): TokenCandidates {
  const byName = new Map<string, ExtractedCssVar>()
  for (const v of buildCssCandidates(cssFiles)) byName.set(v.name, v)
  for (const file of tokenFiles) {
    const isJson = file.relPath.toLowerCase().endsWith('.json')
    let vars: ExtractedCssVar[]
    if (isJson) {
      let parsed: unknown
      try {
        parsed = JSON.parse(file.contents)
      } catch {
        continue // malformed JSON — skip this file, not the whole import
      }
      vars = extractJsonTokens(parsed, file.relPath)
    } else {
      vars = extractJsTokens(file.contents, file.relPath)
    }
    for (const v of vars) byName.set(v.name, v)
  }

  const colors: ColorTokenCandidate[] = []
  const typography: SizeTokenCandidate[] = []
  const spacing: SizeTokenCandidate[] = []
  let otherCount = 0

  for (const v of byName.values()) {
    const category = classifyToken(v.name, v.value)
    if (category === 'color') {
      colors.push({ id: nextCandidateId(), name: v.name, value: v.value, file: v.file })
    } else if (category === 'typography') {
      const px = toPx(v.value)
      if (px !== null) typography.push({ id: nextCandidateId(), name: v.name, value: v.value, px, file: v.file })
      else otherCount += 1
    } else if (category === 'spacing') {
      const px = toPx(v.value)
      if (px !== null) spacing.push({ id: nextCandidateId(), name: v.name, value: v.value, px, file: v.file })
      else otherCount += 1
    } else {
      otherCount += 1
    }
  }

  return { colors, typography, spacing, otherCount }
}
