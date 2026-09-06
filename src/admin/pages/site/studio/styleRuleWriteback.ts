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
 * `resolveCssInsertDestination` (now in `cssInsertDestination.ts`, which also
 * owns the `StyleRule.id -> (file, selector)` registry) decides WHERE such a
 * rule's first write goes — CLAUDE.md's "exactly one honest target", applied
 * to a destination rather than a declaration. `isEditorAuthoredRuleId` is the
 * gate that keeps it from ever firing for an imported rule: only a `nanoid()`
 * id is a candidate.
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
 * does not refuse outright — it names the PAGE this rule belongs to and
 * returns `{ ok: true, kind: 'create', pageFile }`, and `collectStyleRuleEdits`
 * emits an `op: 'create'` edit instead of `insert`.
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
 * synthesis does NOT attempt to synthesize a source for a `create`
 * destination — guessing a path here would be exactly the kind of
 * fabricated write target this module exists to refuse. Instead,
 * `recordCreatedStylesheet` (`cssInsertDestination.ts`) is the explicit seam,
 * fed by `notifyCreatedStylesheets` from the save response's
 * `createdStylesheets` (joined back to a rule id with
 * `ruleIdFromCssCreateNodeId`). The same uncertainty is why a class TOKEN for
 * such a rule is REFUSED rather than guessed on this save — see
 * `classNameWriteback.ts`'s `resolveClassToken`.
 */
import { isGeneratedClass, type Page, type StyleRule } from '@core/page-tree'
import { camelToKebabCssProperty } from '@core/css-codemods'
import {
  buildClassPageIndex,
  getStudioStyleRuleSources,
  isEditorAuthoredRuleId,
  replaceStyleRuleSources,
  resolveCssInsertDestination,
  type StyleRuleSource,
} from './cssInsertDestination'

/**
 * The destination half of this module lives in `cssInsertDestination.ts` (the
 * `StyleRule.id -> (file, selector)` registry, and which file a brand-new
 * class belongs in). Re-exported verbatim so every existing import site is
 * unchanged — see that module's doc for the seam.
 */
export {
  buildClassPageIndex,
  getStudioStyleRuleSources,
  recordCreatedStylesheet,
  resolveCssInsertDestination,
  StyleRuleSourceSchema,
  type CssInsertDestination,
  type StyleRuleSource,
} from './cssInsertDestination'

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

/** Record the load's mapping + baseline. Called once per `loadSite`. */
export function setStudioStyleRuleSources(
  sources: Record<string, StyleRuleSource>,
  styleRules: Record<string, StyleRule>,
  pages: readonly Page[] = [],
): void {
  replaceStyleRuleSources(sources)
  commitBaseline(styleRules, { pages })
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
 *
 * ## `refusedRuleIds` — a baseline must never advance past a refusal
 *
 * `style-02`. This ran unconditionally after every save, including the ones
 * where the server REFUSED the write (a duplicated selector, a covering
 * shorthand, a compiled stylesheet). The declaration never reached disk, but
 * the baseline adopted it anyway — so the user's obvious next move, setting
 * the SAME value again, diffed as "no change", produced no edit, and was
 * never even attempted a second time. The refusal was reported once and then
 * became permanent and invisible.
 *
 * A rule named here keeps its PREVIOUS baseline entry, so the very same
 * change is re-sent on the next save. The caller joins server refusals back
 * to rule ids through `StyleRuleEditPlan.ruleIdByNodeId`, and de-dupes the
 * repeat refusal TOAST rather than the repeat attempt — reporting a thing
 * twice is cheap; silently dropping a user's work is not.
 */
export interface CommitBaselineOptions {
  /** The document's pages, for `buildClassPageIndex`. Empty is safe — it only costs the co-location step. */
  pages?: readonly Page[]
  /** Rules whose write was refused; their baseline entry is preserved, not advanced. */
  refusedRuleIds?: ReadonlySet<string>
}

export function commitBaseline(styleRules: Record<string, StyleRule>, options: CommitBaselineOptions = {}): void {
  const pageIndex = buildClassPageIndex(options.pages ?? [])
  const refused = options.refusedRuleIds
  const previousBaseline = baseline
  const previousContextBaseline = contextBaseline
  baseline = new Map()
  contextBaseline = new Map()
  for (const [id, rule] of Object.entries(styleRules)) {
    if (refused?.has(id)) {
      // Nothing reached disk for this rule — keep the baseline it was diffed
      // against so the same change is attempted again next save.
      const previous = previousBaseline.get(id)
      if (previous) baseline.set(id, previous)
      for (const contextId of realContextIds(rule)) {
        const key = `${id}::${contextId}`
        const previousContext = previousContextBaseline.get(key)
        if (previousContext) contextBaseline.set(key, previousContext)
      }
      continue
    }
    baseline.set(id, effectiveStudioStyles(rule))
    for (const contextId of realContextIds(rule)) {
      contextBaseline.set(`${id}::${contextId}`, { ...rule.contextStyles![contextId] })
    }
    const sources = getStudioStyleRuleSources()
    if (!sources[id] && isEditorAuthoredRuleId(id) && !isGeneratedClass(rule)) {
      const destination = resolveCssInsertDestination(rule, pageIndex)
      if (destination.ok && destination.kind === 'existing') {
        sources[id] = { file: destination.file, selector: rule.selector }
      }
    }
  }
}

/** Every context on a rule that is a REAL media query, not the synthetic studio viewport. */
function realContextIds(rule: StyleRule): string[] {
  return Object.keys(rule.contextStyles ?? {}).filter((id) => id !== STUDIO_BREAKPOINT_ID)
}

/**
 * One class the user changed that could not be written, and the specific
 * reason — `style-02`. `label` and `reason` are separate fields because the
 * caller renders them in different places: the label names WHICH class in the
 * toast title/lead, the reason is the toast body. Concatenating the two into
 * one string (as this used to) produced a self-contradictory sentence — the
 * generic lead said "no hand-editable CSS file in this project" while the
 * appended reason said "Studio found 4 candidate stylesheets".
 */
export interface UnmappedStyleRule {
  label: string
  /** A complete, user-readable sentence, or `null` for "no source, no more specific reason". */
  reason: string | null
}

/** What a save should do about the CSS side of the document. */
export interface StyleRuleEditPlan {
  edits: CssEditPayload[]
  /**
   * Classes the user changed that have no hand-editable `.css` source — the
   * caller must TELL them, not skip silently. See this module's doc.
   */
  unmapped: UnmappedStyleRule[]
  /**
   * Selectors the user changed under a REAL breakpoint/condition. Writing one
   * needs `setDeclarationAtMedia` plus the condition's query, which the
   * `kind: 'css'` edit does not carry yet — so these are reported, never
   * silently dropped.
   */
  unwritableContexts: string[]
  /**
   * Every emitted edit's synthetic `nodeId` mapped back to the `StyleRule.id`
   * it came from. A `css` edit's nodeId is a fabricated join key
   * (`css:<file>#<selector>#<property>`), and the save response echoes it back
   * on `refusals` — this is what lets the caller tell `commitBaseline` which
   * rules must NOT advance. See `commitBaseline`'s `refusedRuleIds`.
   */
  ruleIdByNodeId: Record<string, string>
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
export function collectStyleRuleEdits(
  styleRules: Record<string, StyleRule>,
  pages: readonly Page[] = [],
): StyleRuleEditPlan {
  const edits: CssEditPayload[] = []
  const unmapped: UnmappedStyleRule[] = []
  const unwritableContexts: string[] = []
  const ruleIdByNodeId: Record<string, string> = {}
  const pageIndex = buildClassPageIndex(pages)

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

    const source = getStudioStyleRuleSources()[ruleId]
    if (!source) {
      // Track B1 — an IMPORTED rule with no source has a real reason to stay
      // unmapped (Tailwind/Sass/PostCSS output, a non-.css module); only a
      // rule the user created IN THE EDITOR is an insert candidate at all.
      if (!isEditorAuthoredRuleId(ruleId)) {
        unmapped.push({ label, reason: null })
        continue
      }
      const destination = resolveCssInsertDestination(rule, pageIndex)
      if (!destination.ok) {
        // The destination refusal has its own specific sentence, carried
        // whole — see `UnmappedStyleRule`'s doc for why it is no longer
        // concatenated into the label.
        unmapped.push({ label, reason: destination.message })
        continue
      }
      if (destination.kind === 'existing') {
        const nodeId = `css:insert:${destination.file}#${rule.selector}`
        ruleIdByNodeId[nodeId] = ruleId
        edits.push({
          kind: 'css',
          op: 'insert',
          nodeId,
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
      ruleIdByNodeId[`${CSS_CREATE_NODE_ID_PREFIX}${ruleId}`] = ruleId
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
      const nodeId = `css:${source.file}#${source.selector}#${property}`
      ruleIdByNodeId[nodeId] = ruleId
      edits.push({
        kind: 'css',
        op: 'set',
        nodeId,
        file: source.file,
        selector: source.selector,
        property,
        value,
      })
    }
  }

  return { edits, unmapped, unwritableContexts, ruleIdByNodeId }
}
