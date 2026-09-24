/**
 * cssInsertDestination — WHERE a brand-new class's first declarations go, and
 * the `StyleRule.id -> (file, selector)` registry that answer is read out of.
 *
 * Split out of `styleRuleWriteback.ts` (`module-size-budgets`'s 700-line
 * ceiling) along the seam that was already there: that module owns the DIFF
 * (what changed since the last save), this one owns the DESTINATION (which
 * file a change belongs in). `classNameWriteback.ts` needs the destination
 * without needing the diff — a class TOKEN's spelling depends on whether its
 * stylesheet is a CSS Module, which is a destination question — so keeping the
 * two together made that a circular import waiting to happen.
 *
 * `styleRuleWriteback.ts` re-exports every public name here verbatim, so
 * existing import sites (`StyleTargetChip`, `StyleSurface`, the tests) are
 * unchanged.
 *
 * ## "Exactly one honest target", applied to a FILE
 *
 * CLAUDE.md's write-back invariant is usually about a declaration inside a
 * stylesheet that already exists. `resolveCssInsertDestination` is the same
 * rule one level up: a class the user just created has no file yet, and
 * picking the wrong one is not a cosmetic mistake — the declarations land
 * somewhere the page does not import, and the canvas and the repo disagree
 * forever. So it resolves by a stated order, and — P3-C — it always resolves:
 * choosing among several real stylesheets, or creating the first one, is
 * something the editor can do itself (see `resolveCssInsertDestination`).
 */
import {
  callSitePosition,
  decodeSourceNodeId,
  isImportedStyleRuleId,
  isRouteChromeNodeId,
  type Page,
  type StyleRule,
} from '@core/page-tree'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { Type } from '@core/utils/typeboxHelpers'

/**
 * A `StyleRule.id`'s write-back target, exactly `server/handlers/studioCss.ts`'s
 * `StyleRuleSource`. A rule id absent from the load stream's `styleRuleSources`
 * map has no hand-editable `.css` source.
 */
export const StyleRuleSourceSchema = Type.Object({
  file: Type.String(),
  selector: Type.String(),
})

export interface StyleRuleSource {
  file: string
  selector: string
}

/**
 * `StyleRule.id -> (file, selector)` from the last load's meta line, PLUS
 * every entry Track B1's `commitBaseline` has synthesized since (a rule this
 * session inserted, now writable through the ordinary `set` path).
 * `StyleTargetChip` reads this to explain a class's write-back tier before the
 * user edits it; `collectStyleRuleEdits` reads it to decide where a change
 * goes; `classNameWriteback.ts` reads it to decide how a class token is even
 * SPELLED (a CSS Module class has no literal name — `style-02`).
 */
let styleRuleSources: Record<string, StyleRuleSource> = {}

/** The current workspace's `StyleRule.id -> (file, selector)` write-back map, from the last load. */
export function getStudioStyleRuleSources(): Record<string, StyleRuleSource> {
  return styleRuleSources
}

/** Replaces the whole registry — called once per `loadSite`, through `setStudioStyleRuleSources`. */
export function replaceStyleRuleSources(sources: Record<string, StyleRuleSource>): void {
  styleRuleSources = sources
}

/**
 * The page open on the board, as a project-relative source file (`Z8`).
 *
 * This module used to refuse a freestanding class outright because it "has no
 * notion of which page is open". The CLIENT does, and that is the whole gap:
 * a user creates a class in the Selectors panel while looking at one screen,
 * and the only page it could reasonably belong to is the one they are looking
 * at. Held as module state rather than threaded through a parameter for the
 * same reason `styleRuleSources` is: FIVE call sites ask
 * `resolveCssInsertDestination` the same question — the save planner, the
 * baseline's source synthesis, the `@keyframes` planner, the class-token
 * speller, and the Properties panel's `StyleTargetChip` preview — and a
 * parameter only the save path passed would make the panel grey out rows for
 * a write that now lands. One fact, one place, every surface agreeing.
 */
let openPageFile: string | null = null

/** Publishes which page is open — see `openPageFile`. `null` clears it (no page, or one with no source). */
export function setOpenPageFile(file: string | null): void {
  openPageFile = file
}

/** The page open on the board, as a project-relative source file — `null` when there is none. */
export function getOpenPageFile(): string | null {
  return openPageFile
}

/**
 * `StyleRule.id -> the stylesheet Studio chose for it automatically` (ERR-14).
 *
 * The ranking in `rankCandidateStylesheets` reads session state (which
 * stylesheet was written last), so asked twice it could answer twice
 * differently — and it IS asked twice per write: once by the save planner
 * that sends the `insert`, and again by `commitBaseline`, which records the
 * rule's source from the same question once the insert landed. Remembering
 * the first answer per rule makes the pair agree, and makes the panel's
 * preview and the save agree too: a class goes where the chip said it would.
 * An answer is honoured only while the file is still one of the project's
 * editable stylesheets.
 */
const chosenDestinations = new Map<string, string>()

/**
 * The stylesheet a CSS write landed in most recently this session — the
 * first thing `rankCandidateStylesheets` prefers. A user styling classes into
 * `styles/app.css` expects the next new class to go there too.
 */
let lastWrittenStylesheet: string | null = null

/** Records that a CSS write landed in `file` (called by `saveSite` for every `css` edit the server wrote). */
export function noteStylesheetWritten(file: string): void {
  lastWrittenStylesheet = file
}

/** Forgets every automatic choice and the last-written stylesheet — a different project, or a test. */
export function resetCssDestinationMemory(): void {
  chosenDestinations.clear()
  lastWrittenStylesheet = null
}

/**
 * Records the stylesheet a `create` edit's server response says it actually
 * created (`StudioEditBatchResult.createdStylesheets`, decoded back to a
 * rule id with `ruleIdFromCssCreateNodeId`), so the SAME rule is writable
 * through the ordinary `set` path on its very next edit — with no reload.
 * This is the `create`-branch counterpart of what `commitBaseline` already
 * does automatically for an `existing` destination; it cannot be automatic
 * there because the file name is a SERVER decision, so the caller that owns
 * the save round trip must feed the result back in explicitly.
 */
export function recordCreatedStylesheet(ruleId: string, file: string, selector: string): void {
  styleRuleSources[ruleId] = { file, selector }
}

/**
 * True for a rule the user created IN THE EDITOR (`createClass`/
 * `applyCssRules`, `nanoid()` ids) — never one an import parsed (always the
 * deterministic `sc-` prefix, see `@core/page-tree`'s `styleRuleOrigin.ts`).
 * Only an editor-authored rule is a Track B1 insert candidate: an unmapped
 * IMPORTED rule (Tailwind/Sass/PostCSS output, a non-`.css` module) has a
 * real reason to stay unmapped, and must never silently gain a fabricated
 * write target.
 */
export function isEditorAuthoredRuleId(ruleId: string): boolean {
  return !isImportedStyleRuleId(ruleId)
}

/**
 * Where a brand-new class's first declarations go. Always an answer — P3-C
 * (ERR-14, ERR-15) retired the two refusals this used to end in.
 *
 *   - `kind: 'existing'` — an editable stylesheet this workspace already
 *     writes to (`op: 'insert'`). `alternatives` lists the other candidates
 *     when Studio CHOSE among several (`rankCandidateStylesheets`), so a
 *     surface can say so; it is empty when the answer was the only one.
 *   - `kind: 'create'` — no editable stylesheet exists yet (`op: 'create'`).
 *     `pageFile` names the page to co-locate the new one with, or is `null`
 *     for a class with no page at all, in which case the server creates one
 *     beside the app's entry module and imports it there. The SERVER picks
 *     the actual file name/convention (`studioCssWriteback.ts`'s
 *     `applyCssCreateEdit`).
 */
export type CssInsertDestination =
  | { kind: 'existing'; file: string; alternatives: string[] }
  | { kind: 'create'; pageFile: string | null }

/**
 * One rule the user changed that could not be written, and the specific
 * reason — `style-02`. `label` and `reason` are separate fields because the
 * caller renders them in different places: the label names WHICH rule in the
 * toast title/lead, the reason is the toast body. Concatenating the two into
 * one string (as this used to) produced a self-contradictory sentence — the
 * generic lead said "no hand-editable CSS file in this project" while the
 * appended reason said "Studio found 4 candidate stylesheets".
 *
 * Declared HERE, beside the destination resolution that produces most of
 * these reasons, rather than in `styleRuleWriteback.ts` where it started:
 * `keyframesWriteback.ts` (W5-5) reports the same shape, and having it import
 * the type from its sibling would make the two modules mutually dependent
 * (`no-circular-dependencies.test.ts`). `styleRuleWriteback.ts` re-exports it,
 * so every existing import site is unchanged.
 */
export interface UnmappedStyleRule {
  label: string
  /** A complete, user-readable sentence, or `null` for "no source, no more specific reason". */
  reason: string | null
}

/**
 * `classId -> the one page FILE every node carrying that class lives in`.
 *
 * `style-02` — the co-location step below used to read the page out of
 * `rule.scope.nodeId` alone, which meant it only ever fired for a NODE-SCOPED
 * rule. The only producer of those, `ensureNodeStyleClass`, has no non-test
 * caller, so in practice the step never ran: every new class in a project
 * with two or more stylesheets refused with "Studio found N candidate
 * stylesheets ... and will not guess". The answer was sitting in the document
 * the whole time — the class is ASSIGNED to nodes, and a node id decodes to
 * the file it was parsed from.
 *
 * A class assigned across TWO files is deliberately absent from this map
 * rather than resolved to the first one: there is no single page to co-locate
 * with, which is exactly the ambiguity the refusal below exists for.
 */
export function buildClassPageIndex(pages: readonly Page[]): Map<string, string> {
  const filesByClassId = new Map<string, Set<string>>()
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds.length === 0) continue
      const rel = decodeSourceNodeId(node.id)?.rel
      if (!rel) continue
      for (const classId of node.classIds) {
        const files = filesByClassId.get(classId) ?? new Set<string>()
        files.add(rel)
        filesByClassId.set(classId, files)
      }
    }
  }
  const index = new Map<string, string>()
  for (const [classId, files] of filesByClassId) {
    if (files.size === 1) index.set(classId, [...files][0]!)
  }
  return index
}

/**
 * The page a rule is associated with, or `null` when it has none.
 *
 * Two sources, in order. A NODE-SCOPED rule (`scope: { type: 'node', nodeId,
 * role: 'module-style' }` — `ensureNodeStyleClass`'s auto-created per-element
 * classes) names its element directly, and only when that id is a STUDIO
 * source location (`decodeSourceNodeId`, `rel:line:col`, possibly with a
 * `.map`/inline suffix) does it name a real file. Failing that, `pageIndex`
 * (`buildClassPageIndex`) answers from where the class is actually ASSIGNED
 * — which is what makes co-location work for the ordinary `createClass`
 * flow, where the rule carries no `scope` at all.
 *
 * `null` when neither answers — a class that exists but is on no element yet.
 * That is no longer the end of the road: `resolveCssInsertDestination` falls
 * back to the page the user has OPEN (`openPageFile`, Z8), which is the one
 * page such a class can honestly be said to belong to. The rule's own page
 * still outranks it, so a class already used on Home never follows the board
 * to Onboarding.
 */
function pageFileForRule(rule: StyleRule, pageIndex: ReadonlyMap<string, string>): string | null {
  if (rule.scope?.type === 'node') {
    const scoped = decodeSourceNodeId(rule.scope.nodeId)?.rel
    if (scoped) return scoped
  }
  return pageIndex.get(rule.id) ?? null
}

/**
 * The ONE source file a board page's own markup lives in, or `null` when
 * there is not exactly one — what `setOpenPageFile` should be fed for
 * `activePageId`.
 *
 * Deliberately NOT `server/handlers/studio/pageSourceFile.ts`'s
 * `resolvePageSourceFile`, which answers a deliberately looser question ("a
 * file to READ for this page": first decodable node id wins, tail-first, so
 * an inlined `<Header/>` as the first child answers `components/Header.tsx`).
 * A destination for a WRITE cannot be best-effort — co-locating a new
 * stylesheet next to `Header.tsx` because it happened to be rendered first is
 * exactly the "N places the user didn't ask for" failure. So this reads the
 * CALL SITE of every node (`callSitePosition`, the head of a composite id —
 * always a position in the page's own file, never in the component inlined
 * there) and answers only when they agree on one file.
 *
 * Route chrome is skipped: a Next `layout.tsx`/`template.tsx` is composed into
 * every route beneath it, so a stylesheet co-located with it is a stylesheet
 * every frame imports — one edit, N pages, which is the same refusal one level
 * up. `.map` rows and the synthetic `<pageId>:body` root contribute nothing;
 * neither decodes to a source location at all.
 */
export function resolveOpenPageFile(
  pages: readonly Page[],
  activePageId: string | null | undefined,
): string | null {
  if (!activePageId) return null
  const page = pages.find((entry) => entry.id === activePageId)
  if (!page) return null
  const files = new Set<string>()
  for (const node of Object.values(page.nodes)) {
    const callSite = callSitePosition(node.id)
    if (isRouteChromeNodeId(callSite)) continue
    const rel = decodeSourceNodeId(callSite)?.rel
    if (rel) files.add(rel)
  }
  return files.size === 1 ? [...files][0]! : null
}

/**
 * `pages/Home.tsx` and `pages/Home.module.css` — same directory, same basename
 * up to the first dot. The convention this project scaffolds every page with
 * (`starterPage`'s `stylesFileName`), and the only pairing precise enough to
 * call a destination rather than a guess.
 */
function isCoLocatedStylesheet(pageFile: string, cssFile: string): boolean {
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)
  if (dirOf(pageFile) !== dirOf(cssFile)) return false
  const stemOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).split('.')[0]
  return stemOf(pageFile) === stemOf(cssFile)
}

/** Directory segments of a workspace-relative file path (`pages/Home.tsx` -> `['pages']`). */
function directorySegments(file: string): string[] {
  return file.split('/').slice(0, -1)
}

/** How many leading directory segments two files share — `src/a/x.css` and `src/a/b/y.tsx` share 2. */
function sharedDirectoryDepth(a: string, b: string): number {
  const left = directorySegments(a)
  const right = directorySegments(b)
  let depth = 0
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1
  return depth
}

/**
 * ERR-14 — the candidates, best first, when more than one editable stylesheet
 * could take a new class and none is the rule's own page's. Deterministic from
 * what every caller shares (the rule-source registry, the anchor page, the
 * last write), so the panel's preview and the save agree:
 *
 *   1. the stylesheet written most recently this session — the user is
 *      styling into it;
 *   2. a plain `.css` before a `*.module.css`: a module's classes reach only
 *      the files that import it, while a plain stylesheet is global once
 *      loaded;
 *   3. the nearest to the anchor page by shared directory;
 *   4. the one holding the most rules — the project's main stylesheet;
 *   5. alphabetical, so a tie never depends on iteration order.
 */
function rankCandidateStylesheets(files: readonly string[], anchorPageFile: string | null): string[] {
  const ruleCount = new Map<string, number>()
  for (const source of Object.values(styleRuleSources)) {
    ruleCount.set(source.file, (ruleCount.get(source.file) ?? 0) + 1)
  }
  const isModule = (file: string) => /\.module\.css$/i.test(file)
  const nearness = (file: string) => (anchorPageFile ? sharedDirectoryDepth(file, anchorPageFile) : 0)
  return [...files].sort(
    (a, b) =>
      Number(b === lastWrittenStylesheet) - Number(a === lastWrittenStylesheet) ||
      Number(isModule(a)) - Number(isModule(b)) ||
      nearness(b) - nearness(a) ||
      (ruleCount.get(b) ?? 0) - (ruleCount.get(a) ?? 0) ||
      a.localeCompare(b),
  )
}

/**
 * Where a rule with no write-back source at all should have its first
 * declarations written. Always an answer (P3-C); resolution order:
 *
 *   1. The stylesheet CO-LOCATED WITH THE RULE'S OWN PAGE, when the rule
 *      names one and such a file is already a known write target
 *      (`pages/Home.tsx` -> `pages/Home.module.css`). This is not a guess
 *      among equals: a class created while styling a node on Home belongs in
 *      Home's stylesheet, and `pageFileForRule` recovers that page from the
 *      rule's own scope OR — `style-02` — from where the class is actually
 *      assigned (`buildClassPageIndex`), which is the only one of the two
 *      that fires for a class made the ordinary way.
 *
 *      This step did not exist, and its absence was not a rare edge: the
 *      ambiguity check below counted stylesheets across the WHOLE workspace,
 *      so any project whose pages each own a `*.module.css` — four of them in
 *      the project this was reported from (Home, Onboarding, SMS, SignUp) —
 *      refused EVERY new class with "Studio found 4 candidate stylesheets".
 *   2. Else, the one stylesheet this project already knows how to write to:
 *      every DISTINCT, hand-editable (`classifyStylesheetEditability` ===
 *      'plain-css') `.css` file already named in `styleRuleSources`, IF
 *      there is exactly one.
 *   3. Else, with MORE than one, Studio CHOOSES (ERR-14) —
 *      `rankCandidateStylesheets`, remembered per rule for the session
 *      (`chosenDestinations`) so the save, the baseline and the panel agree.
 *      This used to refuse `ambiguous-stylesheet` and open a "Which
 *      stylesheet should this class live in?" modal ~2 s after the first
 *      keystroke, from autosave, while the user was still typing. Every
 *      candidate IS a real write target — the question was which one, and the
 *      editor can answer it: the file it last wrote, a global sheet over
 *      another page's module, the nearest, the main one. The others ride along
 *      as `alternatives` for any surface that wants to say so.
 *   4. Else (zero candidates) — `kind: 'create'`: beside the anchor page, or,
 *      with no page at all (ERR-15), beside the app's entry module
 *      (`pageFile: null`). That last case used to refuse
 *      `no-editable-stylesheet` — a red "Style not saved to source" for the
 *      first class in a project that simply had no stylesheet yet.
 *
 * ## The anchor page, and why step 1 is no longer a near-miss
 *
 * Steps 1 and 4 both ask "which page is this class's?". That used to be the
 * rule's OWN page and nothing else, so a class created in the Selectors panel
 * before being assigned to anything — the ordinary way to make one — answered
 * `null` and fell through to a refusal in every project with either zero or
 * two-plus stylesheets. Z8 gives that question a second answer: the page the
 * user has OPEN (`openPageFile`). Strictly a FALLBACK, never an override — a
 * class already assigned on Home resolves to Home whichever frame the board is
 * showing.
 */
export function resolveCssInsertDestination(
  rule: StyleRule,
  pageIndex: ReadonlyMap<string, string> = new Map(),
): CssInsertDestination {
  const files = new Set<string>()
  for (const source of Object.values(styleRuleSources)) {
    if (classifyStylesheetEditability(source.file).kind === 'plain-css') files.add(source.file)
  }

  // The rule's own page answers this before any counting does; the open page
  // answers for a rule that has no page of its own yet (Z8).
  const anchorPageFile = pageFileForRule(rule, pageIndex) ?? openPageFile
  if (anchorPageFile) {
    const coLocated = [...files].sort().find((file) => isCoLocatedStylesheet(anchorPageFile, file))
    if (coLocated) return { kind: 'existing', file: coLocated, alternatives: [] }
  }

  if (files.size === 1) return { kind: 'existing', file: [...files][0]!, alternatives: [] }

  if (files.size > 1) {
    const ranked = rankCandidateStylesheets([...files], anchorPageFile)
    const remembered = chosenDestinations.get(rule.id)
    const file = remembered !== undefined && files.has(remembered) ? remembered : ranked[0]!
    chosenDestinations.set(rule.id, file)
    return { kind: 'existing', file, alternatives: ranked.filter((candidate) => candidate !== file) }
  }

  return { kind: 'create', pageFile: anchorPageFile }
}
