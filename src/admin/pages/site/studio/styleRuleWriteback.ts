/**
 * styleRuleWriteback — the client half of WS-6.3's CSS write-back: the
 * `StyleRule.id → (file, selector)` map the server resolved at load time, the
 * baseline every save diffs against, and the `kind: 'css'` edits that diff
 * produces.
 *
 * Extracted from `fsCodemodAdapter.ts` per `debt-01`'s named plan (one module
 * per edit kind, leaving the adapter as the dispatcher its name promises).
 *
 * ## Why a rule can have no write target, and why that is not silence
 *
 * `server/handlers/studioCss.ts` maps a rule id to a file + selector only when
 * the rule was parsed from a REAL, hand-authored `.css` file. A rule that came
 * from compiled output — Tailwind's generated utilities, a Sass/PostCSS build,
 * a CSS Modules compile — has no single hand-authored block to edit, so it is
 * deliberately left unmapped (`meta-03` decision 3's third tier).
 *
 * The obvious implementation is to skip those rules. That is what this code
 * used to do, and it is wrong: the user changes a value, the canvas updates,
 * autosave runs, nothing reaches disk, and NOTHING SAYS SO. `StyleTargetChip`
 * warns at the moment they pick the target, but a warning a user has already
 * dismissed is not consent for a later silent no-op — and on reload the work
 * is simply gone.
 *
 * So an unmapped rule is a first-class REFUSAL here, reported through
 * `collectStyleRuleEdits`'s `unmapped` list and toasted by the caller with the
 * same wording tier the chip uses. `meta-03`'s "Tailwind projects get utility
 * class edits on the element" is the eventual *fix* for that tier — an element
 * `className` edit, not a declaration edit, and a genuinely separate feature —
 * but until it exists the honest behaviour is to say so, not to pretend.
 *
 * ## The `studio` context IS the base declaration set
 *
 * The obvious reading of `StyleRule` is that `styles` holds the base
 * declarations and `contextStyles[breakpointId]` holds media-query overrides,
 * so a write-back that only understands base declarations should read
 * `styles`. That is wrong here, and wrong in a way no unit test caught: it
 * made this whole feature write nothing at all, ever.
 *
 * Every board frame mounts a SYNTHETIC breakpoint — `id: 'studio'`, built by
 * `BoardFramesLayer.tsx`'s `buildStudioBreakpoint` and sized to that frame's
 * own width. It is the only context a studio board is ever in, so
 * `StyleSurface`'s `activeContextId` is `'studio'` for every edit a user makes
 * on the canvas, and every value they type lands in
 * `contextStyles.studio`, never in `styles`. Diffing `styles` alone therefore
 * compared two identical bags on every save and emitted nothing.
 *
 * That synthetic breakpoint is not a media query the user authored — it is the
 * board's viewport. So its declarations ARE the rule's plain declarations, and
 * `effectiveStudioStyles` folds it over `styles` to give the one value the
 * canvas is actually showing. That folded value is what gets diffed and what
 * gets written.
 *
 * A REAL user breakpoint (`mobile`/`tablet`, or a `@media` condition) is a
 * different matter — writing it needs `setDeclarationAtMedia` and a query to
 * write, which this pass does not carry. Those changes are reported through
 * `unwritableContexts` rather than dropped, for the same reason unmapped rules
 * are: silence is the one outcome that loses a user's work without telling
 * them.
 *
 * ## Baseline discipline
 *
 * `commitBaseline` advances the diff baseline after each save round trip, so
 * one user change produces exactly one write attempt and exactly one refusal
 * message. Without it every subsequent autosave tick would re-send an
 * already-applied edit (harmless but wasteful — `setDeclaration` reports no
 * change) and, far worse, re-toast an already-reported refusal on a 2-second
 * timer for as long as the session lasts.
 *
 * ## Track B1 — a rule with no source at all
 *
 * `unmapped` above covers an IMPORTED rule that has a real reason to stay
 * that way (Tailwind/Sass/PostCSS output, a non-`.css` module — see the doc
 * above). It is the wrong outcome for a rule with no `sc-` prefix — one the
 * user just created in the editor (`createClass`/`applyCssRules`, `nanoid()`
 * ids) — because THAT rule has never had a chance to reach disk at all;
 * reporting it "unmapped forever" is exactly the `unmapped` silent-loss bug
 * this module's own doc above describes, just for a different cause.
 *
 * `resolveCssInsertDestination` decides WHERE such a rule's first write goes
 * (CLAUDE.md's "exactly one honest target", applied to a destination rather
 * than a declaration): the one editable `.css` file this project's already-
 * parsed rules point at, if there is exactly one — else refuse, naming why.
 * `isEditorAuthoredRuleId` is the gate that keeps this from ever firing for
 * an imported rule: only a `nanoid()` id is a candidate.
 *
 * Once a destination resolves, `commitBaseline` SYNTHESIZES a
 * `styleRuleSources` entry for it (after the save that carried the insert
 * succeeds — see `commitBaseline`'s own doc), so the SAME rule is writable
 * through the ordinary `set` path on its very next edit, with no reload.
 * Missing this seam was the failure mode named in this work order: a rule
 * that writes once and then becomes unmapped again on the next edit.
 *
 * ## Creating a NEW stylesheet (the plan's deferred middle branch, now landed)
 *
 * When zero editable stylesheets exist yet, `resolveCssInsertDestination`
 * does not refuse outright — it tries to name the PAGE this rule belongs to
 * (`scope.nodeId`, decoded via `@core/page-tree`'s `decodeSourceNodeId` —
 * only a NODE-SCOPED rule, i.e. one `ensureNodeStyleClass` auto-created for a
 * specific element, carries this; a freestanding class made with
 * `createClass` while nothing is selected has no page association at all,
 * and gets the ordinary refusal instead of a guess). If a page resolves, the
 * destination is `{ ok: true, kind: 'create', pageFile }` and
 * `collectStyleRuleEdits` emits an `op: 'create'` edit instead of `insert`.
 *
 * The SERVER does the actual work (`studioCssWriteback.ts`'s
 * `applyCssCreateEdit`) — detects whether this project leans on CSS Modules
 * or plain `.css`, computes and validates a co-located stylesheet path next
 * to the page, wires the page's `import` (a ts-morph edit, which is why this
 * cannot happen client-side), and writes the rule's declarations into it.
 * The client has no full-workspace file listing (only the stylesheets its
 * already-parsed rules point at), so it could not have made the convention
 * decision honestly itself.
 *
 * Because the CLIENT does not know which file the server actually created
 * until the save response says so, `commitBaseline`'s automatic per-rule
 * synthesis (below) does NOT attempt to synthesize a source for a `create`
 * destination — guessing a path here would be exactly the kind of
 * fabricated write target this module exists to refuse. Instead,
 * `recordCreatedStylesheet` is the explicit seam: once a save's response
 * reports `createdStylesheets` (`StudioEditBatchResult`, decoded back to a
 * rule id with `ruleIdFromCssCreateNodeId`), the caller records the mapping
 * so the SAME rule is writable through the ordinary `set` path on its very
 * next edit — with no reload. Wiring that call into `fsCodemodAdapter.ts`'s
 * save-success path is the one piece left for whoever owns that file next
 * (out of this pass's ownership, same posture as the `unmapped` toast-
 * wording gap documented above); `recordCreatedStylesheet` and the node-id
 * codec are exported specifically so that wiring is a few lines, not a
 * redesign. Absent that wiring, the rule becomes writable on the NEXT page
 * load regardless (the server's newly-created file gets picked up like any
 * other `.css` file the next time `studioCss.ts` parses the workspace).
 */
import { decodeSourceNodeId, isGeneratedClass, type StyleRule } from '@core/page-tree'
import { camelToKebabCssProperty, classifyStylesheetEditability } from '@core/css-codemods'
import { Type } from '@core/utils/typeboxHelpers'

/**
 * The synthetic per-frame breakpoint every studio board frame mounts. Declared
 * here rather than imported because its producer,
 * `canvas/BoardFramesLayer/BoardFramesLayer.tsx`, builds it as a private
 * const; `styleRuleWriteback.test.ts` asserts the two stay in agreement, so
 * this cannot silently drift back into writing nothing.
 */
export const STUDIO_BREAKPOINT_ID = 'studio'

/**
 * The declarations a studio board is actually SHOWING for this rule: the
 * synthetic `studio` context folded over the rule's own base bag. See this
 * module's "The `studio` context IS the base declaration set".
 */
function effectiveStudioStyles(rule: StyleRule): Record<string, unknown> {
  return { ...rule.styles, ...(rule.contextStyles?.[STUDIO_BREAKPOINT_ID] ?? {}) }
}

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

/** One EXISTING rule's declaration change, matching `studioCssWriteback.ts`'s `CssSetEditSchema`. */
export interface CssSetEditPayload {
  kind: 'css'
  op: 'set'
  nodeId: string
  file: string
  selector: string
  property: string
  value: string
}

/**
 * A brand-new rule's first write into an EXISTING stylesheet (Track B1),
 * matching `studioCssWriteback.ts`'s `CssInsertEditSchema`. `declarations` is
 * the rule's FULL current bag (there is nothing to diff against yet),
 * kebab-cased the same way `property` is for a `set` edit.
 */
export interface CssInsertEditPayload {
  kind: 'css'
  op: 'insert'
  nodeId: string
  file: string
  selector: string
  declarations: Record<string, string>
  atMedia?: string
}

/**
 * A brand-new rule's first write into a stylesheet that DOES NOT EXIST YET
 * (Track B1's deferred branch, now landed), matching `studioCssWriteback.ts`'s
 * `CssCreateEditSchema`. `pageFile` is the page this rule is co-located
 * with — see `resolveCssInsertDestination`'s doc for how it is derived and
 * why a rule with no page association never reaches this shape.
 */
export interface CssCreateEditPayload {
  kind: 'css'
  op: 'create'
  nodeId: string
  pageFile: string
  selector: string
  declarations: Record<string, string>
  atMedia?: string
}

/** One `kind: 'css'` edit, matching `server/handlers/studioCssWriteback.ts`'s `CssEditSchema` union. */
export type CssEditPayload = CssSetEditPayload | CssInsertEditPayload | CssCreateEditPayload

/** `nodeId` prefix an `op: 'create'` edit is synthesized with — see `ruleIdFromCssCreateNodeId`. */
const CSS_CREATE_NODE_ID_PREFIX = 'css:create:'

/**
 * Recovers the `StyleRule.id` a `create` edit's synthetic `nodeId` was built
 * from. `StudioEditBatchResult.createdStylesheets` (server response) echoes
 * this `nodeId` back verbatim — the standard join key every edit kind's
 * result already uses (`swapDetails`, `refusals`, …) — so a caller that owns
 * the save round trip can decode which rule a reported `file` belongs to and
 * pass both to `recordCreatedStylesheet`. `null` for anything else (a `set`/
 * `insert` edit's nodeId, or a foreign string).
 */
export function ruleIdFromCssCreateNodeId(nodeId: string): string | null {
  return nodeId.startsWith(CSS_CREATE_NODE_ID_PREFIX) ? nodeId.slice(CSS_CREATE_NODE_ID_PREFIX.length) : null
}

/**
 * `StyleRule.id -> (file, selector)` from the last load's meta line, PLUS
 * every entry Track B1's `commitBaseline` has synthesized since (a rule this
 * session inserted, now writable through the ordinary `set` path). `mutable`
 * here means exactly that "plus" — see `commitBaseline`'s doc.
 * `StyleTargetChip` reads this to explain a class's write-back tier before the
 * user edits it; `collectStyleRuleEdits` reads it to decide where a change goes.
 */
let styleRuleSources: Record<string, StyleRuleSource> = {}

/**
 * True for a rule the user created IN THE EDITOR (`createClass`/
 * `applyCssRules`, `nanoid()` ids) — never one an import parsed (always the
 * deterministic `sc-` prefix, see `studioCss.ts`'s "Stable ids"). Only an
 * editor-authored rule is a Track B1 insert candidate: an unmapped IMPORTED
 * rule (Tailwind/Sass/PostCSS output, a non-`.css` module) has a real reason
 * to stay unmapped, and must never silently gain a fabricated write target.
 */
function isEditorAuthoredRuleId(ruleId: string): boolean {
  return !ruleId.startsWith('sc-')
}

/**
 * A resolved insert destination, or a NAMED refusal — CLAUDE.md's "exactly
 * one honest target" applied to WHICH FILE a brand-new rule belongs in,
 * rather than to a declaration inside one that already exists.
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
 * The page a rule is associated with, or `null` when it has none. Only a
 * NODE-SCOPED rule (`scope: { type: 'node', nodeId, role: 'module-style' }`
 * — `ensureNodeStyleClass`'s auto-created per-element classes) carries a
 * `nodeId`, and only when that id is a STUDIO source location
 * (`decodeSourceNodeId`, `rel:line:col`, possibly with a `.map`/inline
 * suffix) does it name a real file. A freestanding class made with
 * `createClass`/`applyCssRules` while nothing is selected has no `scope` at
 * all — there genuinely is no page to co-locate a brand-new stylesheet with,
 * so `resolveCssInsertDestination` refuses for those rather than guessing
 * "the currently open page" (this module has no notion of which page is
 * open — see its own "Baseline discipline").
 */
function pageFileForRule(rule: StyleRule): string | null {
  if (rule.scope?.type !== 'node') return null
  return decodeSourceNodeId(rule.scope.nodeId)?.rel ?? null
}

/**
 * Where a rule with no write-back source at all should have its first
 * declarations written. Resolution order — see this module's "Creating a
 * NEW stylesheet" doc above for the full design:
 *
 *   1. The one stylesheet this project already knows how to write to: every
 *      DISTINCT, hand-editable (`classifyStylesheetEditability` ===
 *      'plain-css') `.css` file already named in `styleRuleSources`, IF
 *      there is exactly one. This module has no per-page context (see its
 *      own "Baseline discipline" — `collectStyleRuleEdits` runs over the
 *      whole `site.styleRules` registry, not one page's), so "the
 *      stylesheet the page imports" narrows here to "the one this
 *      workspace's already-parsed rules point at" — an honest, documented
 *      approximation that is exact for the common single-stylesheet
 *      project and refuses rather than guesses for anything less clear.
 *   2. Else, if the count was MORE than one, refuse with
 *      `ambiguous-stylesheet`, naming every candidate — Studio will not
 *      guess which file a new class belongs in. This branch NEVER creates:
 *      the ambiguity is about multiple EXISTING choices, not about needing
 *      a new one.
 *   3. Else (zero candidates) — try to name the rule's PAGE
 *      (`pageFileForRule`). If one resolves, offer `kind: 'create'`. If not,
 *      refuse with `no-editable-stylesheet`.
 */
export function resolveCssInsertDestination(rule: StyleRule): CssInsertDestination {
  const files = new Set<string>()
  for (const source of Object.values(styleRuleSources)) {
    if (classifyStylesheetEditability(source.file).kind === 'plain-css') files.add(source.file)
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

  const pageFile = pageFileForRule(rule)
  if (pageFile) return { ok: true, kind: 'create', pageFile }

  return {
    ok: false,
    reason: 'no-editable-stylesheet',
    message:
      'Studio could not find a hand-editable .css file in this project, and this class has no page to co-locate ' +
      'a new one with. Select the element while styling it, or add a .css file to the project, then try again.',
  }
}

/**
 * Every style rule's EFFECTIVE declarations as last synced, keyed by rule id —
 * `effectiveStudioStyles`, not the raw `styles` bag. Same "only write what the
 * user actually changed" discipline `fsCodemodAdapter`'s `loadedValues`
 * applies to node props.
 */
let baseline = new Map<string, Record<string, unknown>>()

/**
 * Every rule's REAL (non-studio) context bags as last synced, keyed
 * `ruleId::contextId`. Kept separate from `baseline` because those bags are
 * not folded into the effective value — comparing a `mobile` override against
 * the effective base would report every imported override as "changed" the
 * first time a save ran.
 */
let contextBaseline = new Map<string, Record<string, unknown>>()

/** The current workspace's `StyleRule.id -> (file, selector)` write-back map, from the last load. */
export function getStudioStyleRuleSources(): Record<string, StyleRuleSource> {
  return styleRuleSources
}

/** Record the load's mapping + baseline. Called once per `loadSite`. */
export function setStudioStyleRuleSources(
  sources: Record<string, StyleRuleSource>,
  styleRules: Record<string, StyleRule>,
): void {
  styleRuleSources = sources
  commitBaseline(styleRules)
}

/**
 * Advance the diff baseline to the state just sent — see this module's
 * "Baseline discipline". Called ONLY after a save round trip completes
 * without throwing (the caller's `await apiRequest(...)` having already
 * succeeded), which is exactly the moment Track B1's source synthesis below
 * needs: a `commitBaseline` call that never runs means the save never
 * landed, so nothing should be assumed writable yet either.
 *
 * Track B1 — synthesizes a `styleRuleSources` entry for a rule that just had
 * its first successful write (an `insert` edit `collectStyleRuleEdits` just
 * sent), so it is writable through the ordinary `set` path on its VERY NEXT
 * edit, with no reload. Restricted to editor-authored, non-generated rules
 * with no source yet — the identical gate `collectStyleRuleEdits` checks
 * before ever emitting an insert for one — so a rule that legitimately has
 * no honest destination (an imported, unmapped rule) never gets a
 * fabricated source here either. Harmless to re-attempt for a rule that
 * hasn't been styled yet at all (zero declarations): `setDeclaration`
 * already creates a missing rule on demand, so a synthesized-but-not-yet-
 * written source just means the NEXT edit takes the ordinary `set` path
 * instead of needing its own `insert`.
 *
 * Only an `existing` destination is synthesized here — a `create`
 * destination's real file name is decided by the SERVER (project convention
 * detection needs a full workspace file listing this client does not have),
 * so guessing one here would be exactly the fabricated-write-target bug this
 * module exists to prevent. See `recordCreatedStylesheet` for the `create`
 * counterpart of this seam.
 */
export function commitBaseline(styleRules: Record<string, StyleRule>): void {
  baseline = new Map()
  contextBaseline = new Map()
  for (const [id, rule] of Object.entries(styleRules)) {
    baseline.set(id, effectiveStudioStyles(rule))
    for (const contextId of realContextIds(rule)) {
      contextBaseline.set(`${id}::${contextId}`, { ...rule.contextStyles![contextId] })
    }
    if (!styleRuleSources[id] && isEditorAuthoredRuleId(id) && !isGeneratedClass(rule)) {
      const destination = resolveCssInsertDestination(rule)
      if (destination.ok && destination.kind === 'existing') {
        styleRuleSources[id] = { file: destination.file, selector: rule.selector }
      }
    }
  }
}

/**
 * Records the stylesheet a `create` edit's server response says it actually
 * created (`StudioEditBatchResult.createdStylesheets`, decoded back to a
 * rule id with `ruleIdFromCssCreateNodeId`), so the SAME rule is writable
 * through the ordinary `set` path on its very next edit — with no reload.
 * This is the `create`-branch counterpart of what `commitBaseline` already
 * does automatically for an `existing` destination; it cannot be automatic
 * here because the file name is a SERVER decision (see `commitBaseline`'s
 * doc), so the caller that owns the save round trip must feed the result
 * back in explicitly.
 */
export function recordCreatedStylesheet(ruleId: string, file: string, selector: string): void {
  styleRuleSources[ruleId] = { file, selector }
}

/** Every context on a rule that is a REAL media query, not the synthetic studio viewport. */
function realContextIds(rule: StyleRule): string[] {
  return Object.keys(rule.contextStyles ?? {}).filter((id) => id !== STUDIO_BREAKPOINT_ID)
}

/** What a save should do about the CSS side of the document. */
export interface StyleRuleEditPlan {
  edits: CssEditPayload[]
  /**
   * Selectors the user changed that have no hand-editable `.css` source — the
   * caller must TELL them, not skip silently. See this module's doc.
   */
  unmapped: string[]
  /**
   * Selectors the user changed under a REAL breakpoint/condition. Writing one
   * needs `setDeclarationAtMedia` plus the condition's query, which the
   * `kind: 'css'` edit does not carry yet — so these are reported, never
   * silently dropped.
   */
  unwritableContexts: string[]
}

/**
 * Diff each rule's EFFECTIVE declarations (see `effectiveStudioStyles`)
 * against the last synced baseline and produce the `kind: 'css'` edits for
 * rules with a real source, plus the two lists of changes that could not be
 * written and must therefore be reported.
 *
 * A property REMOVED since the last sync (present in the baseline, absent
 * now) is left alone — `setDeclaration` only sets a value, it has no "remove"
 * operation yet, and inventing one that deletes lines from a user's
 * stylesheet is not something to do as a side effect of a diff.
 */
export function collectStyleRuleEdits(styleRules: Record<string, StyleRule>): StyleRuleEditPlan {
  const edits: CssEditPayload[] = []
  const unmapped: string[] = []
  const unwritableContexts: string[] = []

  for (const [ruleId, rule] of Object.entries(styleRules)) {
    // A framework-generated utility (`.text-color-metal`, `.bg-color-metal-5`,
    // the typography/spacing steps) is DERIVED from the token settings in
    // `.studio/framework.json` and regenerated from them — there is no
    // hand-authored `.css` file behind it, and there never will be. It has no
    // `styleRuleSources` entry for exactly that reason, so it used to fall
    // through to `unmapped` and be reported as "Style not saved to source".
    //
    // That report was wrong twice over. Nothing was lost — the class is
    // regenerated from its token, which IS persisted — and the classes are
    // `locked: true`, so the user could not have edited them in the first
    // place. What actually produced the toast was a baseline gap: importing a
    // design system adds colour tokens, the framework generates a utility
    // class per token, and those classes appear in `site.styleRules` AFTER
    // `commitBaseline` last ran. Every property then reads as "changed"
    // against an empty baseline, and a whole screen's worth of untouched
    // generated classes gets listed as failed writes on the next save.
    //
    // Skipped before the diff rather than filtered out of `unmapped` after it,
    // so they cannot produce a spurious edit either.
    if (isGeneratedClass(rule)) continue

    const before = baseline.get(ruleId) ?? {}
    const current = effectiveStudioStyles(rule)
    const label = rule.selector || rule.name

    // A real `@media` context the user touched. Compared against the baseline
    // the same way, so an untouched imported override never reports.
    for (const contextId of realContextIds(rule)) {
      const contextBag = rule.contextStyles?.[contextId] ?? {}
      const contextBefore = contextBaseline.get(`${ruleId}::${contextId}`) ?? {}
      const touched = Object.entries(contextBag).some(([property, value]) => !Object.is(contextBefore[property], value))
      if (touched && !unwritableContexts.includes(label)) unwritableContexts.push(label)
    }

    const changed: [property: string, value: string][] = []
    for (const [property, value] of Object.entries(current)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      if (Object.is(before[property], value)) continue
      // Keys are camelCase (`CSSPropertyBag`'s convention everywhere in this
      // editor); a real `.css` file only understands kebab-case names.
      changed.push([camelToKebabCssProperty(property), String(value)])
    }
    if (changed.length === 0) continue

    const source = styleRuleSources[ruleId]
    if (!source) {
      // Track B1 — an IMPORTED rule with no source has a real reason to stay
      // unmapped (Tailwind/Sass/PostCSS output, a non-.css module); only a
      // rule the user created IN THE EDITOR is an insert candidate at all.
      if (!isEditorAuthoredRuleId(ruleId)) {
        unmapped.push(label)
        continue
      }
      const destination = resolveCssInsertDestination(rule)
      if (!destination.ok) {
        // The destination refusal has its own specific reason — fold it into
        // the label text itself (rather than dropping it) since this plan's
        // `unmapped` wire carries plain strings, joined verbatim into the
        // caller's toast; this is still "refuse and say why", just carried
        // in the one channel available here.
        unmapped.push(`${label} — ${destination.message}`)
        continue
      }
      if (destination.kind === 'existing') {
        edits.push({
          kind: 'css',
          op: 'insert',
          nodeId: `css:insert:${destination.file}#${rule.selector}`,
          file: destination.file,
          selector: rule.selector,
          declarations: Object.fromEntries(changed),
        })
        continue
      }
      // `kind: 'create'` — no editable stylesheet exists yet; the server
      // invents one co-located with `destination.pageFile` and reports back
      // which file it made (`recordCreatedStylesheet`/`notifyCreatedStylesheets`
      // pick that up from the save response). `nodeId` carries the rule id
      // itself so the response can be joined back to it — see
      // `ruleIdFromCssCreateNodeId`.
      edits.push({
        kind: 'css',
        op: 'create',
        nodeId: `${CSS_CREATE_NODE_ID_PREFIX}${ruleId}`,
        pageFile: destination.pageFile,
        selector: rule.selector,
        declarations: Object.fromEntries(changed),
      })
      continue
    }
    for (const [property, value] of changed) {
      edits.push({
        kind: 'css',
        op: 'set',
        nodeId: `css:${source.file}#${source.selector}#${property}`,
        file: source.file,
        selector: source.selector,
        property,
        value,
      })
    }
  }

  return { edits, unmapped, unwritableContexts }
}
