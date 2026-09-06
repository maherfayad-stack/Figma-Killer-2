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
 * forever. So it resolves, or it refuses by name.
 */
import { decodeSourceNodeId, isImportedStyleRuleId, type Page, type StyleRule } from '@core/page-tree'
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
 * A resolved insert destination, or a NAMED refusal.
 *
 *   - `kind: 'existing'` — the one editable stylesheet this workspace
 *     already knows how to write to (`op: 'insert'`).
 *   - `kind: 'create'` — no editable stylesheet exists yet, but this rule
 *     names a page to co-locate a NEW one with (`op: 'create'`); the SERVER
 *     picks the actual file name/convention (see `studioCssWriteback.ts`'s
 *     `applyCssCreateEdit`).
 */
export type CssInsertDestination =
  | { ok: true; kind: 'existing'; file: string }
  | { ok: true; kind: 'create'; pageFile: string }
  | { ok: false; reason: 'no-editable-stylesheet' | 'ambiguous-stylesheet'; message: string }

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
 * `null` when neither answers: a class that exists but is on no element yet
 * genuinely has no page to co-locate a brand-new stylesheet with, and
 * `resolveCssInsertDestination` refuses rather than guessing "the currently
 * open page" (this module has no notion of which page is open).
 */
function pageFileForRule(rule: StyleRule, pageIndex: ReadonlyMap<string, string>): string | null {
  if (rule.scope?.type === 'node') {
    const scoped = decodeSourceNodeId(rule.scope.nodeId)?.rel
    if (scoped) return scoped
  }
  return pageIndex.get(rule.id) ?? null
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

/**
 * Where a rule with no write-back source at all should have its first
 * declarations written. Resolution order:
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
 *   3. Else, if the count was MORE than one, refuse with
 *      `ambiguous-stylesheet`, naming every candidate — Studio will not
 *      guess which file a new class belongs in. This branch NEVER creates:
 *      the ambiguity is about multiple EXISTING choices, not about needing
 *      a new one.
 *   4. Else (zero candidates) — try to name the rule's PAGE
 *      (`pageFileForRule`). If one resolves, offer `kind: 'create'`. If not,
 *      refuse with `no-editable-stylesheet`.
 */
export function resolveCssInsertDestination(
  rule: StyleRule,
  pageIndex: ReadonlyMap<string, string> = new Map(),
): CssInsertDestination {
  const files = new Set<string>()
  for (const source of Object.values(styleRuleSources)) {
    if (classifyStylesheetEditability(source.file).kind === 'plain-css') files.add(source.file)
  }

  // The rule's own page answers this before any counting does.
  const rulePageFile = pageFileForRule(rule, pageIndex)
  if (rulePageFile) {
    const coLocated = [...files].sort().find((file) => isCoLocatedStylesheet(rulePageFile, file))
    if (coLocated) return { ok: true, kind: 'existing', file: coLocated }
  }

  if (files.size === 1) return { ok: true, kind: 'existing', file: [...files][0]! }

  if (files.size > 1) {
    return {
      ok: false,
      reason: 'ambiguous-stylesheet',
      message:
        `Studio found ${files.size} candidate stylesheets in this project (${[...files].sort().join(', ')}) ` +
        'and will not guess which one a new class belongs in.',
    }
  }

  if (rulePageFile) return { ok: true, kind: 'create', pageFile: rulePageFile }

  return {
    ok: false,
    reason: 'no-editable-stylesheet',
    message:
      'Studio could not find a hand-editable .css file in this project, and this class has no page to co-locate ' +
      'a new one with. Select the element while styling it, or add a .css file to the project, then try again.',
  }
}
