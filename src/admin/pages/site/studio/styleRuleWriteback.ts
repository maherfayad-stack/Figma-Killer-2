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
 */
import { isGeneratedClass, type StyleRule } from '@core/page-tree'
import { camelToKebabCssProperty } from '@core/css-codemods'
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

/** One `kind: 'css'` edit, matching `server/handlers/studioCssWriteback.ts`'s `CssEditSchema`. */
export interface CssEditPayload {
  kind: 'css'
  nodeId: string
  file: string
  selector: string
  property: string
  value: string
}

/**
 * `StyleRule.id -> (file, selector)` from the last load's meta line.
 * `StyleTargetChip` reads this to explain a class's write-back tier before the
 * user edits it; `collectStyleRuleEdits` reads it to decide where a change goes.
 */
let styleRuleSources: Record<string, StyleRuleSource> = {}

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

/** Advance the diff baseline to the state just sent — see this module's "Baseline discipline". */
export function commitBaseline(styleRules: Record<string, StyleRule>): void {
  baseline = new Map()
  contextBaseline = new Map()
  for (const [id, rule] of Object.entries(styleRules)) {
    baseline.set(id, effectiveStudioStyles(rule))
    for (const contextId of realContextIds(rule)) {
      contextBaseline.set(`${id}::${contextId}`, { ...rule.contextStyles![contextId] })
    }
  }
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
      unmapped.push(label)
      continue
    }
    for (const [property, value] of changed) {
      edits.push({
        kind: 'css',
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
