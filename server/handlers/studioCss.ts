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
 * rule's own identity (`kind` + `name` + its resolved source FILE) — same CSS
 * in, same ids out, forever.
 *
 * The file is part of the id (Track B1, fixing `docs/audits/2026-08-06/
 * 10-classes-vs-inline-styles.md` §S3d): two REAL `.css` files each defining
 * `.button` produce two DIFFERENT `StyleRule`s, each with its own honest
 * `sources` entry, rather than collapsing onto one id that silently drops the
 * earlier file's block. `classIdsByName` (below) still resolves one class
 * NAME to exactly one id — the later-parsed file wins there, matching CSS
 * cascade order closely enough for canvas rendering — so `node.classIds`
 * stays unambiguous even though the registry itself no longer discards the
 * earlier rule. A rule with no single hand-authored file to key by
 * (`extraCss`'s Tailwind/Sass/PostCSS output, or a CSS-Modules selector with
 * no resolvable origin) hashes on an empty file string, preserving today's
 * "later wins" collapsing for that case — there is genuinely no file to
 * distinguish them by.
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
import { IMPORTED_RULE_ID_PREFIX, IMPORTED_RULE_TIMESTAMP, type ConditionDef, type StyleRule } from '@core/page-tree'
import { cssToStyleRules, type ImportWarning } from '@core/siteImport'
import { collectEntryStylesheets, collectPageStylesheets } from '@core/studio-sync/collectPageStylesheets'
import type { PageStylesheet } from '@core/studio-sync/pageStylesheet'

/** Guard against a pathological vendored bundle being pulled in as "the page's CSS". */
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

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
  /**
   * Track B1/B3 — every `cssToStyleRules` parse warning across every
   * stylesheet this load merged, in merge order. Previously discarded
   * entirely (`mergeParsedCss` called `cssToStyleRules` and only ever read
   * `.rules`/`.conditions` off the result) — the ONLY signal that a
   * stylesheet partially failed (an unparseable declaration, a dropped
   * at-rule, a blocked property) had nowhere to go. Not yet surfaced to the
   * client — `studioPageLoad.ts`/`studioLoadResponse.ts` own that wiring —
   * but no longer silently thrown away at the source.
   */
  warnings: ImportWarning[]
  /**
   * `board-27` — every stylesheet's RAW text this load read, concatenated in
   * the same order `mergeParsedCss` parsed them (`extraCss` first, then each
   * `.css` file in cascade order). This is the byte-faithful counterpart to
   * `styleRules`: happy-dom's CSSOM (`cssToStyleRules`, above) silently drops
   * any declaration it cannot parse — `color-mix()`, `Canvas`/`CanvasText`
   * system colours, slash-alpha `rgb(0 0 0 / .2)` all measured — so the
   * REGISTRY can no longer be trusted to render what the project's own CSS
   * actually says. The client renders THIS text verbatim
   * (`AuthoredCssInjector`) and uses `styleRules` only for the parts that
   * genuinely need structured access: the CSS Classes panel and the write-
   * back diff. See `canvasClassCss.ts`'s `styleRuleNeedsCanvasOverlay` for how
   * the two stay reconciled once a user edits an imported rule mid-session.
   */
  authoredCss: string
}

const EMPTY_STYLES: StudioStyles = { styleRules: {}, conditions: [], classIdsByName: {}, sources: {}, warnings: [], authoredCss: '' }

/**
 * Deterministic rule id. Derived from the rule's identity so the same CSS
 * always yields the same id across reloads — see this module's "Stable ids".
 * The `sc-` prefix keeps imported rules recognisable next to editor-authored
 * ones, which use `nanoid()`.
 *
 * `file` is part of the hash (Track B1's landmine fix, `docs/audits/
 * 2026-08-06/10-classes-vs-inline-styles.md` §S3d). It used to be omitted —
 * `styleRuleId(kind, name)` hashed identity alone — so two REAL `.css` files
 * each defining `.button` collapsed onto ONE id: `styleRules[id]` kept only
 * the later file's declarations, and `sources[id]` pointed only at the later
 * file, so the earlier `.button` block was invisible in the registry AND had
 * no honest write target of its own. Passing `''` for a rule with no single
 * hand-authored file (an `extraCss`-contributed Tailwind/Sass/PostCSS
 * utility, or a CSS-Modules rule `cssModuleSource` can't resolve to exactly
 * one file) preserves today's collapsing behaviour for THAT case — there
 * genuinely is no file to distinguish them by, and `mergeParsedCss`'s
 * "later redefinition wins" comment already documents that as the accepted
 * approximation for a read-only view.
 *
 * `classIdsByName` (below) still resolves one name to ONE id — the later
 * file wins there too, matching cascade order for RENDER purposes — so this
 * change does not ripple into `node.classIds`/canvas rendering: it only
 * stops the earlier rule from being silently destroyed in the registry.
 */
export function styleRuleId(kind: StyleRule['kind'], name: string, file: string): string {
  return `${IMPORTED_RULE_ID_PREFIX}${createHash('sha1').update(`${kind}|${name}|${file}`).digest('hex').slice(0, 10)}`
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

/** One generated CSS-Modules class, pointed back at the source it was renamed from. */
interface ModuleClassOrigin {
  /** Workspace-relative POSIX path of the `*.module.css` file. */
  file: string
  /** The local class name as WRITTEN there, e.g. `row`. */
  local: string
}

/**
 * Invert `CompiledStyles.moduleClassMaps` — `{ file: { local: generated } }` —
 * into `generated -> { file, local }`.
 *
 * A generated name is `<fileBase>_<local>__<hash>` (`styleCompile.ts`'s
 * `renamePrelude`), so it is unique across files by construction and this
 * inversion cannot collide. Only `*.module.css` is compiled today; the
 * `.scss`/`.sass`/`.less` module variants are reported as a warning rather
 * than renamed, so they never appear here and correctly stay unmapped.
 */
function invertModuleClassMaps(
  maps: Record<string, Record<string, string>> | undefined,
): Map<string, ModuleClassOrigin> {
  const inverted = new Map<string, ModuleClassOrigin>()
  if (!maps) return inverted
  for (const [file, classMap] of Object.entries(maps)) {
    if (!/\.module\.css$/i.test(file)) continue // only a syntax `setDeclaration` can parse
    for (const [local, generated] of Object.entries(classMap)) {
      inverted.set(generated, { file, local })
    }
  }
  return inverted
}

/** Class tokens in a selector — `.foo`, `.foo:hover`, `.a .b`, `.a.b`. */
const SELECTOR_CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g

/**
 * The hand-authored `(file, selector)` a COMPILED CSS-Modules rule came from,
 * or `undefined` when there isn't exactly one honest answer.
 *
 * ## Why this exists
 *
 * `*.module.css` files are excluded from per-file discovery above and reach
 * the registry through `extraCss` under their RENAMED selectors, which had no
 * `sources` entry — so every CSS-Modules rule was unmapped by construction.
 * Two visible consequences: the CSS Classes panel reported "Style not saved to
 * source" for any edit to one, and a `kind: 'css'` write-back had no file to
 * target. Both looked like policy ("generated styles aren't editable") and
 * were really just a missing inverse of a map `styleCompile.ts` already
 * computes.
 *
 * ## The one-honest-target rule, applied to a selector
 *
 * Every generated class token is substituted back to its local name, so
 * `.SmsPhone_row__a1b2:hover .SmsPhone_icon__c3d4` becomes `.row:hover .icon`
 * — which is literally what the source file contains, making it a valid
 * `setDeclaration` target rather than a guess.
 *
 * Two cases deliberately return `undefined` instead:
 *   - **No token is a generated name** — this is ordinary Tailwind/Sass output
 *     from `extraCss`, which genuinely has no hand-authored rule to point at.
 *   - **Tokens resolve to DIFFERENT module files** — possible via `composes`
 *     or a selector written across two modules. There is no single file to
 *     write to, so refusing is the honest outcome, exactly as the write-back
 *     engine refuses a node with more than one source location.
 *
 * A token that matches nothing is left as written: a global class in a module
 * file (`:global(.foo)`) is not renamed, so passing it through reproduces the
 * source faithfully.
 */
function cssModuleSource(
  selector: string,
  byGeneratedClass: Map<string, ModuleClassOrigin>,
): StyleRuleSource | undefined {
  if (byGeneratedClass.size === 0) return undefined

  const files = new Set<string>()
  const rebuilt = selector.replace(SELECTOR_CLASS_RE, (whole, className: string) => {
    const origin = byGeneratedClass.get(className)
    if (!origin) return whole
    files.add(origin.file)
    return `.${origin.local}`
  })

  if (files.size !== 1) return undefined
  return { file: [...files][0]!, selector: rebuilt }
}

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
  moduleClassMaps?: Record<string, Record<string, string>>,
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
  const warnings: ImportWarning[] = []
  // `board-27` — the raw text of every stylesheet, in the same order it's
  // parsed below (`extraCss` first, then each sheet in cascade order). See
  // `StudioStyles.authoredCss`'s doc for why this exists alongside the
  // (lossy) `styleRules` registry.
  const authoredCssParts: string[] = []
  const moduleSourceByGeneratedClass = invertModuleClassMaps(moduleClassMaps)
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
    authoredCssParts.push(cssText)
    const parsed = cssToStyleRules(cssText, { sheetConstructor: SheetCtor })
    for (const condition of parsed.conditions) conditionsById.set(condition.id, condition)
    warnings.push(...parsed.warnings)

    const mappable = sourceFile !== undefined && /\.css$/i.test(sourceFile)
    for (const rule of parsed.rules) {
      // The source is resolved BEFORE the id, because the id now carries the
      // file (Track B1's `styleRuleId` fix — see its doc comment): two REAL
      // `.css` files each defining `.button` must produce two DIFFERENT ids,
      // not collapse onto one that silently drops the earlier file's block.
      // A rule with no single hand-authored file (`extraCss`, or a
      // CSS-Modules selector `cssModuleSource` can't resolve to exactly one
      // file) hashes on `''` instead, preserving today's "later wins"
      // collapsing for that case — there is genuinely no file to key by.
      const source = mappable
        ? { file: sourceFile!, selector: rule.selector }
        : cssModuleSource(rule.selector, moduleSourceByGeneratedClass)
      const id = styleRuleId(rule.kind, rule.name, source?.file ?? '')
      // A later stylesheet redefining the same (kind, name, file) wins —
      // this only fires for genuine same-file re-parses / `extraCss`
      // duplicates now, since two DIFFERENT files no longer share an id.
      // `order` still advances so relative sort position is preserved.
      // A CSS Modules rule's `name` is the COMPILED class the DOM carries
      // (`SignUp_socialBtn__a1b2c`). That is the right thing to render,
      // cascade, and match `classIds` with — and exactly the wrong thing to
      // show a person, who is looking at `.socialBtn` in the file. Display
      // only; nothing downstream keys off it. See `styleRuleDisplaySelector`.
      const localName = rule.kind === 'class' ? moduleSourceByGeneratedClass.get(rule.name)?.local : undefined
      styleRules[id] = {
        ...rule,
        id,
        ...(localName && localName !== rule.name ? { displayName: localName } : {}),
        order: order++,
        createdAt: IMPORTED_RULE_TIMESTAMP,
        updatedAt: IMPORTED_RULE_TIMESTAMP,
      }
      // `classIdsByName` still resolves one NAME to exactly one id — the
      // LATEST file wins, matching cascade order for canvas rendering
      // purposes (same accepted approximation as before this change; see
      // `styleRuleId`'s doc for why this does not need to change too).
      if (rule.kind === 'class') classIdsByName[rule.name] = id
      if (source) sources[id] = source
      else delete sources[id]
    }
  }

  if (extraCss) mergeParsedCss(extraCss)

  for (const sheet of sheets.values()) {
    const cssText = readStylesheet(sheet)
    if (cssText === undefined) continue
    mergeParsedCss(cssText, sheet.relPath)
  }

  // Track B1/B3 — these used to vanish entirely (only `.rules`/`.conditions`
  // were ever read off `cssToStyleRules`'s result). A dropped at-rule, an
  // unknown/blocked property, or a duplicate class is the only signal that a
  // stylesheet partially failed, so log it rather than stay silent even
  // though nothing downstream reads `warnings` yet.
  if (warnings.length > 0) {
    console.warn(`[studioCss] ${warnings.length} CSS parse warning(s) across this project's stylesheets`)
  }

  return {
    styleRules,
    conditions: [...conditionsById.values()],
    classIdsByName,
    sources,
    warnings,
    authoredCss: authoredCssParts.join('\n\n'),
  }
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
