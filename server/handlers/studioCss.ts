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
 * ## READ-ONLY (§6.6)
 *
 * There is no CSS writeback codemod. Editing one of these rules in the CSS
 * Classes panel updates the in-memory site document and is LOST on the next
 * reload — the `.css` file on disk is never rewritten. Two-way CSS editing
 * would need a CSS-text codemod alongside `ast-codemods`, which is a separate
 * initiative. This is documented in `docs/features/studio-import.md`; do not
 * let a user discover it by losing work.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Project } from 'ts-morph'
import type { ParsedPage } from '@core/page-parser'
import type { ConditionDef, StyleRule } from '@core/page-tree'
import { cssToStyleRules } from '@core/siteImport'
import { collectPageStylesheets, type PageStylesheet } from '@core/studio-sync/collectPageStylesheets'

/** Guard against a pathological vendored bundle being pulled in as "the page's CSS". */
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

/**
 * Rules are not user-authored here — the `.css` file is the record of change —
 * so a real timestamp would differ on every reload and churn the document for
 * no reason. Fixed at 0, the same value `parseTimestamp` falls back to.
 */
const IMPORTED_RULE_TIMESTAMP = 0

export interface StudioStyles {
  /** Keyed by rule id, ready to assign to `site.styleRules`. */
  styleRules: Record<string, StyleRule>
  /** Reusable `@media`/`@container`/`@supports` conditions referenced by the rules' `contextStyles`. */
  conditions: ConditionDef[]
  /** Class NAME -> rule id, for `classIdsForClassName`. Only names with a real rule appear. */
  classIdsByName: Record<string, string>
}

const EMPTY_STYLES: StudioStyles = { styleRules: {}, conditions: [], classIdsByName: {} }

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

/**
 * Reads and parses every stylesheet the given parsed pages import, merging
 * them into one registry in cascade order. Never throws — an unreadable or
 * unparseable stylesheet is skipped with a logged warning, because a broken
 * `.css` file must not take the whole workspace load down with it.
 *
 * `pages` carries each page's parsed tree alongside the workspace-relative
 * path it came from, which is what `collectPageStylesheets` needs to walk
 * outward from.
 */
export async function loadStudioStyles(
  pages: readonly { parsed: ParsedPage; relFile: string }[],
  project: Project,
  workspaceRoot: string,
): Promise<StudioStyles> {
  const sheets = new Map<string, PageStylesheet>()
  for (const { parsed, relFile } of pages) {
    for (const sheet of collectPageStylesheets(parsed, relFile, project, workspaceRoot)) {
      if (!sheets.has(sheet.absPath)) sheets.set(sheet.absPath, sheet)
    }
  }
  if (sheets.size === 0) return EMPTY_STYLES

  const SheetCtor = await loadSheetConstructor()
  if (!SheetCtor) return EMPTY_STYLES

  const styleRules: Record<string, StyleRule> = {}
  const conditionsById = new Map<string, ConditionDef>()
  const classIdsByName: Record<string, string> = {}
  let order = 0

  for (const sheet of sheets.values()) {
    const cssText = readStylesheet(sheet)
    if (cssText === undefined) continue

    const parsed = cssToStyleRules(cssText, { sheetConstructor: SheetCtor })
    for (const condition of parsed.conditions) conditionsById.set(condition.id, condition)

    for (const rule of parsed.rules) {
      const id = styleRuleId(rule.kind, rule.name)
      // A later stylesheet redefining the same name wins, matching cascade
      // order — `order` still advances so relative sort position is preserved.
      styleRules[id] = { ...rule, id, order: order++, createdAt: IMPORTED_RULE_TIMESTAMP, updatedAt: IMPORTED_RULE_TIMESTAMP }
      if (rule.kind === 'class') classIdsByName[rule.name] = id
    }
  }

  return { styleRules, conditions: [...conditionsById.values()], classIdsByName }
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
