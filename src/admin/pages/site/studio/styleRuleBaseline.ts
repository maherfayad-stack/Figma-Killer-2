/**
 * styleRuleBaseline — what the LAST save left behind, so the next one sends
 * only what the user actually changed.
 *
 * Split out of `styleRuleWriteback.ts` along the seam that was already there:
 * that module answers "which edits does this document need", this one answers
 * "changed since when". Two genuinely different reasons to change — a new edit
 * KIND (W4-4 Phase B's `styled`, which is what pushed the combined file past
 * `module-size-budgets`' ceiling) touches the first and not the second, and a
 * baseline-discipline fix touches the second and not the first.
 *
 * `styleRuleWriteback.ts` re-exports every public name here verbatim, so every
 * existing import site is unchanged — the same arrangement
 * `cssInsertDestination.ts` already has with it.
 *
 * ## The `studio` context IS the base declaration set
 *
 * The obvious reading of `StyleRule` is that `styles` holds the base
 * declarations and `contextStyles[breakpointId]` holds media-query overrides.
 * That is wrong here, and wrong in a way no unit test caught: it made the
 * whole write-back feature emit nothing at all, ever.
 *
 * Every board frame mounts a SYNTHETIC breakpoint — `id: 'studio'`, built by
 * `BoardFramesLayer.tsx`'s `buildStudioBreakpoint` and sized to that frame's
 * own width. It is the only context a studio board is ever in, so every value
 * a user types on the canvas lands in `contextStyles.studio`, never in
 * `styles`, and diffing `styles` alone compared two identical bags on every
 * save. That synthetic breakpoint is not a media query the user authored — it
 * is the board's viewport — so its declarations ARE the rule's plain
 * declarations, and `effectiveStudioStyles` folds it over `styles` to give the
 * one value the canvas is actually showing. That folded value is what gets
 * diffed and what gets written.
 *
 * ## Baseline discipline
 *
 * `commitBaseline` advances the diff baseline after each save round trip, so
 * one user change produces exactly one write attempt and exactly one refusal
 * message. Without it every subsequent autosave tick would re-send an
 * already-applied edit (harmless but wasteful) and, far worse, re-toast an
 * already-reported refusal on a 2-second timer for as long as the session
 * lasts.
 */
import { isGeneratedClass, type Page, type StyleRule } from '@core/page-tree'
import {
  buildClassPageIndex,
  getStudioStyleRuleSources,
  isEditorAuthoredRuleId,
  replaceStyleRuleSources,
  resolveCssInsertDestination,
  type StyleRuleSource,
} from './cssInsertDestination'
import { commitKeyframesBaseline } from './keyframesWriteback'
import { replaceStyledRuleSources, type StyledRuleSource } from './styledRuleSources'

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
export function effectiveStudioStyles(rule: StyleRule): Record<string, unknown> {
  return { ...rule.styles, ...(rule.contextStyles?.[STUDIO_BREAKPOINT_ID] ?? {}) }
}

/**
 * Every style rule's EFFECTIVE declarations as last synced, keyed by rule id —
 * `effectiveStudioStyles`, not the raw `styles` bag. Same "only write what the
 * user actually changed" discipline `fsCodemodAdapter`'s `loadedValues`
 * applies to node props.
 */
let baseline = new Map<string, Record<string, unknown>>()

/** The declarations `ruleId` was last synced with — what `collectStyleRuleEdits` diffs against. */
export function baselineFor(ruleId: string): Record<string, unknown> {
  return baseline.get(ruleId) ?? {}
}

/**
 * Every rule's REAL (non-studio) context bags as last synced, keyed
 * `ruleId::contextId`. Kept separate from `baseline` because those bags are
 * not folded into the effective value — comparing a `mobile` override against
 * the effective base would report every imported override as "changed" the
 * first time a save ran.
 */
let contextBaseline = new Map<string, Record<string, unknown>>()

/** The declarations `ruleId`’s REAL (non-studio) context was last synced with. */
export function contextBaselineFor(ruleId: string, contextId: string): Record<string, unknown> {
  return contextBaseline.get(`${ruleId}::${contextId}`) ?? {}
}

/**
 * Record the load's mapping + baseline. Called once per `loadSite`, and once
 * per TARGETED reload (`studioLiveReloadFetch.ts`) — which is why it takes the
 * full `CommitBaselineOptions` rather than just `pages`: a reload triggered by
 * a save whose CSS edits the server refused must not adopt the on-disk value
 * as the new baseline for those rules, or the user's retry diffs as "no
 * change" and is never attempted again (`style-02`'s bug #3, reachable through
 * the reload path even after that fix).
 */
export function setStudioStyleRuleSources(
  sources: Record<string, StyleRuleSource>,
  styleRules: Record<string, StyleRule>,
  options: StudioStyleSourcesOptions = {},
): void {
  replaceStyleRuleSources(sources)
  // W4-4 Phase B — the CSS-in-JS half of the same answer, replaced in the
  // same breath so no code path can ever see one map refreshed and the other
  // stale. Absent means EMPTY, which is the correct registry for a project
  // with no CSS-in-JS and for a caller that never loaded any.
  replaceStyledRuleSources(options.styledSources ?? {})
  commitBaseline(styleRules, options)
}

/**
 * What one LOAD records: the baseline options `commitBaseline` needs, plus the
 * styled-template map that only a load can supply. Separate from
 * `CommitBaselineOptions` because `commitBaseline` also runs on its own after
 * every save, where there is no new registry to install.
 */
export interface StudioStyleSourcesOptions extends CommitBaselineOptions {
  /** W4-4 Phase B — `StyleRule.id -> styled template`, from the load’s meta line. */
  styledSources?: Record<string, StyledRuleSource>
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
  // `@keyframes` bodies are diffed on `rawCss`, not on a declaration bag, so
  // they keep their own baseline — advanced here under the identical
  // refusal rule (`keyframesWriteback.ts`).
  commitKeyframesBaseline(styleRules, refused)
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
export function realContextIds(rule: StyleRule): string[] {
  return Object.keys(rule.contextStyles ?? {}).filter((id) => id !== STUDIO_BREAKPOINT_ID)
}
