/**
 * studioCss — §6 of the Studio import pipeline: turns the `.css` files an
 * imported page imports into the `StyleRule` registry the editor and publisher
 * actually render from.
 *
 * `collectPageStylesheets` (`@core/studio-sync`) decides WHICH files and in
 * what order; this module reads them, parses each with the existing
 * `cssToStyleRules` engine, and assigns stable ids. `classIdsForClassName`
 * then lets the page converter turn a literal `className="a b"` into
 * `node.classIds`, which is the only way styling attaches in this engine.
 *
 * ## CSSOM in Bun
 *
 * `cssToStyleRules` parses through a real `CSSStyleSheet`. Bun has none, so we
 * hand it happy-dom's constructor (happy-dom is a runtime dependency, not
 * dev-only). It is loaded lazily on the first Studio load that has any CSS, and
 * INJECTED rather than assigned onto `globalThis` — growing browser globals in
 * a long-lived server process would silently change behaviour for every other
 * module that feature-detects them.
 *
 * ## Stable ids
 *
 * Studio reloads the whole site document on every `requestCmsSiteReload()` and
 * on a `shifted` save, so a random id per load would churn selection, undo
 * history, and every `node.classIds` entry. Ids are therefore derived from the
 * rule's own identity (`kind` + `name`) — same CSS in, same ids out, forever.
 *
 * Two files defining the same class name collapse onto one id, with the
 * later-parsed file winning. That matches CSS cascade order closely enough for
 * a read-only view and keeps `classIds` unambiguous.
 *
 * ## Write-back mapping (§6.3, `panel-02`)
 *
 * `sources` is the `StyleRule.id -> (file, selector)` map WS-6.3's write-back
 * needs: `server/handlers/studioWriteback.ts`'s `kind: 'css'` edit dispatches
 * to `@core/css-codemods`'s `setDeclaration` using exactly this file/selector
 * pair. Only rules parsed from a REAL `.css` file on disk get an entry — a
 * rule contributed by `extraCss` (Tailwind/Sass/PostCSS output, rewritten CSS
 * Modules selectors — see "WS-2.1" below) has no single hand-authored file to
 * point at, so it is left unmapped on purpose: the write path treats an
 * unmapped rule id as "no editable source", which is the correct outcome for
 * a generated class per `meta-03` decision 3. A non-`.css` stylesheet
 * (`.scss`/`.sass`/`.less`, accepted as an IMPORT specifier by
 * `collectPageStylesheets` but not a syntax `setDeclaration`'s postcss parse
 * understands) is unmapped for the same reason — see the `/\.css$/i` guard
 * below.
 *
 * A rule with NO mapping still edits fine in the CSS Classes panel — the
 * in-memory `site.styleRules` entry updates immediately — it just does not
 * reach disk; `StyleTargetChip` says so for that specific rule (see
 * `classifyStylesheetEditability` for the exact wording per tier).
 *
 * ## WS-2.1 — compiled styles (`extraCss`)
 *
 * `loadStudioStyles`'s optional `extraCss` parameter is
 * `server/handlers/studio/styleCompile.ts`'s `CompiledStyles.css` — Sass,
 * PostCSS/Tailwind output, and rewritten CSS Modules selectors, already
 * concatenated into one blob. It is parsed through this SAME
 * `cssToStyleRules` call, right after the entry stylesheets and before each
 * page's own CSS, so its rules land in the identical registry with the
 * identical deterministic id scheme — one producer feeding one consumer, not
 * a second styling system. `*.module.css` files are excluded from the
 * ordinary per-file discovery below (`isCompiledElsewhere`) because
 * `styleCompile.ts` already reads, renames, and contributes them via
 * `extraCss` — discovering them again here would additionally register their
 * UNSCOPED selector names, which no literal `className` in the source ever
 * references.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Project } from 'ts-morph'
import type { ParsedPage } from '@core/page-parser'
import type { ConditionDef, StyleRule } from '@core/page-tree'
import { cssToStyleRules } from '@core/siteImport'
import { collectEntryStylesheets, collectPageStylesheets, type PageStylesheet } from '@core/studio-sync/collectPageStylesheets'

/** Guard against a pathological vendored bundle being pulled in as "the page's CSS". */
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

/**
 * Rules are not user-authored here — the `.css` file is the record of change —
 * so a real timestamp would differ on every reload and churn the document for
 * no reason. Fixed at 0, the same value `parseTimestamp` falls back to.
 */
const IMPORTED_RULE_TIMESTAMP = 0

/** Where a `StyleRule` was parsed from, when it has a single hand-authored `.css` file to point at — see this module's "Write-back mapping" doc. */
export interface StyleRuleSource {
  /** Workspace-relative POSIX path, same convention as every `StudioEdit.nodeId`'s `rel`. */
  file: string
  /** The rule's selector exactly as written in that file — `setDeclaration`'s match key. */
  selector: string
}

export interface StudioStyles {
  /** Keyed by rule id, ready to assign to `site.styleRules`. */
  styleRules: Record<string, StyleRule>
  /** Reusable `@media`/`@container`/`@supports` conditions referenced by the rules' `contextStyles`. */
  conditions: ConditionDef[]
  /** Class NAME -> rule id, for `classIdsForClassName`. Only names with a real rule appear. */
  classIdsByName: Record<string, string>
  /** Rule id -> its source `.css` file + selector, for rules with one — see "Write-back mapping". */
  sources: Record<string, StyleRuleSource>
}

const EMPTY_STYLES: StudioStyles = { styleRules: {}, conditions: [], classIdsByName: {}, sources: {} }

/**
 * Deterministic rule id. Derived from the rule's identity so the same CSS
 * always yields the same id across reloads — see this module's "Stable ids".
 * The `sc-` prefix keeps imported rules recognisable next to editor-authored
 * ones, which use `nanoid()`.
 */
export function styleRuleId(kind: StyleRule['kind'], name: string): string {
  return `sc-${createHash('sha1').update(`${kind}|${name}`).digest('hex').slice(0, 10)}`
}

/**
 * Splits a literal `className` into the `classIds` the engine renders from,
 * dropping any name with no matching rule. A dangling id would point at a
 * rule the editor can't show or edit, so an unstyled class name is simply not
 * carried over — the source file keeps it either way, since `className` is
 * never rewritten by this path.
 */
export function classIdsForClassName(className: string, classIdsByName: Record<string, string>): string[] {
  const ids: string[] = []
  for (const name of className.split(/\s+/)) {
    const id = name ? classIdsByName[name] : undefined
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** `*.module.css`/`.scss`/`.sass`/`.less` — already compiled and rewritten by `styleCompile.ts`, contributed via `extraCss` instead. See this module's "WS-2.1 — compiled styles" doc. */
const COMPILED_ELSEWHERE_RE = /\.module\.(css|scss|sass|less)$/i

/**
 * Reads and parses every stylesheet the given parsed pages import, merging
 * them into one registry in cascade order. Never throws — an unreadable or
 * unparseable stylesheet is skipped with a logged warning, because a broken
 * `.css` file must not take the whole workspace load down with it.
 *
 * `pages` carries each page's parsed tree alongside the workspace-relative
 * path it came from, which is what `collectPageStylesheets` needs to walk
 * outward from. `extraCss`, when non-empty, is `styleCompile.ts`'s compiled
 * output — parsed through the same engine right after the entry stylesheets;
 * see this module's "WS-2.1" doc for why.
 */
export async function loadStudioStyles(
  pages: readonly { parsed: ParsedPage; relFile: string }[],
  project: Project,
  workspaceRoot: string,
  extraCss?: string,
): Promise<StudioStyles> {
  const sheets = new Map<string, PageStylesheet>()
  // Global stylesheets FIRST — resets and design tokens must precede the
  // per-screen rules that reference them. See `collectEntryStylesheets`.
  for (const sheet of collectEntryStylesheets(project, workspaceRoot)) {
    if (!sheets.has(sheet.absPath) && !COMPILED_ELSEWHERE_RE.test(sheet.relPath)) sheets.set(sheet.absPath, sheet)
  }
  for (const { parsed, relFile } of pages) {
    for (const sheet of collectPageStylesheets(parsed, relFile, project, workspaceRoot)) {
      if (!sheets.has(sheet.absPath) && !COMPILED_ELSEWHERE_RE.test(sheet.relPath)) sheets.set(sheet.absPath, sheet)
    }
  }
  if (sheets.size === 0 && !extraCss) return EMPTY_STYLES

  const SheetCtor = await loadSheetConstructor()
  if (!SheetCtor) return EMPTY_STYLES

  const styleRules: Record<string, StyleRule> = {}
  const conditionsById = new Map<string, ConditionDef>()
  const classIdsByName: Record<string, string> = {}
  const sources: Record<string, StyleRuleSource> = {}
  let order = 0

  /**
   * `sourceFile` is the workspace-relative `.css` path this text was read
   * from, or `undefined` for `extraCss` (no single hand-authored file — see
   * "Write-back mapping"). Only a literal `.css` file gets a `sources` entry
   * — `.scss`/`.sass`/`.less` are accepted as import specifiers elsewhere in
   * this pipeline but are not syntax `setDeclaration`'s postcss parse
   * understands, so mapping one would let a save silently corrupt it.
   */
  const mergeParsedCss = (cssText: string, sourceFile?: string): void => {
    const parsed = cssToStyleRules(cssText, { sheetConstructor: SheetCtor })
    for (const condition of parsed.conditions) conditionsById.set(condition.id, condition)

    const mappable = sourceFile !== undefined && /\.css$/i.test(sourceFile)
    for (const rule of parsed.rules) {
      const id = styleRuleId(rule.kind, rule.name)
      // A later stylesheet redefining the same name wins, matching cascade
      // order — `order` still advances so relative sort position is preserved.
      styleRules[id] = { ...rule, id, order: order++, createdAt: IMPORTED_RULE_TIMESTAMP, updatedAt: IMPORTED_RULE_TIMESTAMP }
      if (rule.kind === 'class') classIdsByName[rule.name] = id
      // A later redefinition's mapping (or lack of one) replaces the earlier
      // rule's, same "later wins" rule as `styleRules` itself above.
      if (mappable) sources[id] = { file: sourceFile!, selector: rule.selector }
      else delete sources[id]
    }
  }

  if (extraCss) mergeParsedCss(extraCss)

  for (const sheet of sheets.values()) {
    const cssText = readStylesheet(sheet)
    if (cssText === undefined) continue
    mergeParsedCss(cssText, sheet.relPath)
  }

  return { styleRules, conditions: [...conditionsById.values()], classIdsByName, sources }
}

function readStylesheet(sheet: PageStylesheet): string | undefined {
  try {
    const text = readFileSync(sheet.absPath, 'utf8')
    if (text.length > MAX_STYLESHEET_BYTES) {
      console.warn('[studioCss] skipping oversized stylesheet:', sheet.relPath)
      return undefined
    }
    return text
  } catch (err) {
    console.error('[studioCss] could not read stylesheet', sheet.relPath, err)
    return undefined
  }
}

/** Lazily-loaded happy-dom CSSOM, cached for the process. `null` once loading has failed, so a broken install doesn't retry on every request. */
let sheetConstructor: typeof CSSStyleSheet | null | undefined

/**
 * `GlobalWindow`, not `Window`: happy-dom's CSS parser reports selector errors
 * through `this.window.SyntaxError`, and only `GlobalWindow` puts the JS
 * built-ins on the window object. With a plain `Window` every stylesheet fails
 * to parse with "undefined is not a constructor". `src/__tests__/setup.ts`
 * picks `GlobalWindow` for the same reason.
 *
 * Constructing it does NOT assign anything to `globalThis` (verified) — the
 * test setup's global assignment is a separate, explicit step there.
 */
async function loadSheetConstructor(): Promise<typeof CSSStyleSheet | null> {
  if (sheetConstructor !== undefined) return sheetConstructor
  try {
    const { GlobalWindow } = await import('happy-dom')
    const window = new GlobalWindow({
      settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
    })
    sheetConstructor = window.CSSStyleSheet as unknown as typeof CSSStyleSheet
  } catch (err) {
    console.error('[studioCss] happy-dom CSSOM unavailable — imported CSS will be skipped', err)
    sheetConstructor = null
  }
  return sheetConstructor
}
