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
import { isGeneratedClass, type Breakpoint, type ConditionDef, type Page, type StyleRule } from '@core/page-tree'
import { camelToKebabCssProperty } from '@core/css-codemods'
import {
  buildClassPageIndex,
  getStudioStyleRuleSources,
  isEditorAuthoredRuleId,
  resolveCssInsertDestination,
  type UnmappedStyleRule,
} from './cssInsertDestination'
import { collectKeyframesEdits, type CssKeyframeEditPayload } from './keyframesWriteback'
import {
  getStudioStyledRuleSources,
  styledEditNodeId,
  type StyledEditPayload,
  type StyledRuleSource,
} from './styledRuleSources'
import { baselineFor, contextBaselineFor, effectiveStudioStyles, realContextIds } from './styleRuleBaseline'

/**
 * The BASELINE half of this module lives in `styleRuleBaseline.ts` (what the
 * last save left behind, and the `studio`-context fold every diff here reads
 * through). Re-exported verbatim so every existing import site is unchanged —
 * the same arrangement `cssInsertDestination.ts` already has.
 */
export {
  commitBaseline,
  effectiveStudioStyles,
  setStudioStyleRuleSources,
  STUDIO_BREAKPOINT_ID,
  type CommitBaselineOptions,
  type StudioStyleSourcesOptions,
} from './styleRuleBaseline'

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
  type UnmappedStyleRule,
} from './cssInsertDestination'


/** One EXISTING rule's declaration change, matching `studioCssWriteback.ts`'s `CssSetEditSchema`. */
export interface CssSetEditPayload {
  kind: 'css'
  op: 'set'
  nodeId: string
  file: string
  selector: string
  property: string
  value: string
  /** A breakpoint/condition override's media query — see `mediaQueryForContext`. */
  atMedia?: string
}

/**
 * One EXISTING declaration CLEARED (`style-03`), matching
 * `studioCssWriteback.ts`'s `CssUnsetEditSchema`. The exact counterpart of
 * `set`, and the reason the diff below now looks at the BASELINE's keys as
 * well as the current ones.
 */
export interface CssUnsetEditPayload {
  kind: 'css'
  op: 'unset'
  nodeId: string
  file: string
  selector: string
  property: string
  atMedia?: string
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

/**
 * One `kind: 'css'` edit, matching `server/handlers/studioCssWriteback.ts`'s
 * `CssEditSchema` union — including W5-5's three `@keyframes` ops, whose
 * payload shapes and diff live in `keyframesWriteback.ts` for the same
 * one-reason-per-module split the server side makes.
 */
export type CssEditPayload =
  | CssSetEditPayload
  | CssUnsetEditPayload
  | CssInsertEditPayload
  | CssCreateEditPayload
  | CssKeyframeEditPayload

/**
 * Everything one save round trip should write for the STYLE side of the
 * document. Two edit KINDS, because a project can hold both a `.css` file and
 * a `styled.div` and the user edits them through the same inspector row — see
 * `styledRuleSources.ts` for why the two write paths must not be one.
 */
export type StyleEditPayload = CssEditPayload | StyledEditPayload

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


/** What a save should do about the CSS side of the document. */
export interface StyleRuleEditPlan {
  edits: StyleEditPayload[]
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
   *
   * A LIST, not one id, because W4-4 Phase B's `styled` edits target a real
   * `rel:line:col` — the template's own tag — which every declaration in that
   * template legitimately shares. One refused `color` write there must hold
   * back the base rule AND the `:hover` rule flattened out of the same
   * template, since neither reached disk under that node id.
   */
  ruleIdsByNodeId: Record<string, string[]>
}

/**
 * The editing contexts a document defines, in the shape this module needs:
 * a viewport breakpoint's `mediaQuery` and a named condition's `condition`.
 * Passed in rather than read off `SiteDocument` so this module stays a leaf
 * (and so a test can state exactly one context without a whole document).
 */
export interface StyleRuleContexts {
  breakpoints?: readonly Breakpoint[]
  conditions?: readonly ConditionDef[]
}

/**
 * The `@media` query a `contextStyles` key writes under, or a NAMED refusal.
 *
 * `style-03`. Three answers, and the third is the point:
 *
 *   - a viewport context (`site.breakpoints`) contributes its own
 *     `mediaQuery` — that field exists precisely because the frame WIDTH is an
 *     editor concern and the query is the published condition.
 *   - a `kind: 'media'` condition contributes its query verbatim.
 *   - a `container`/`supports` condition contributes NOTHING: those are
 *     `@container` / `@supports` blocks, not `@media`, and
 *     `setDeclarationAtMedia` would silently write the wrong at-rule. They
 *     keep the refusal this whole path used to give every context.
 */
function mediaQueryForContext(contextId: string, contexts: StyleRuleContexts): string | null {
  const breakpoint = contexts.breakpoints?.find((entry) => entry.id === contextId)
  if (breakpoint) return breakpoint.mediaQuery ?? `(max-width: ${breakpoint.width}px)`
  const condition = contexts.conditions?.find((entry) => entry.id === contextId)
  if (condition?.condition.kind === 'media') return condition.condition.query
  return null
}

/** One property's diff outcome: a new value to write, or a removal. */
type PropertyChange = { property: string; value: string } | { property: string; value: null }

/**
 * Kebab-cased property changes between two declaration bags — including the
 * ones that DISAPPEARED (`value: null`).
 *
 * That second half is `style-03`'s fix. This used to iterate `after` only, so
 * clearing a declaration in the inspector produced no edit at all: the canvas
 * updated, the save reported success, and the property came back on the next
 * reload with nothing said. Both directions now produce an edit, and both go
 * through the same `analyzeDeclarationTarget` gate server-side.
 */
function diffDeclarations(before: Record<string, unknown>, after: Record<string, unknown>): PropertyChange[] {
  const changes: PropertyChange[] = []
  for (const [property, value] of Object.entries(after)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    if (Object.is(before[property], value)) continue
    // Keys are camelCase (`CSSPropertyBag`'s convention everywhere in this
    // editor); a real `.css` file only understands kebab-case names.
    changes.push({ property: camelToKebabCssProperty(property), value: String(value) })
  }
  for (const property of Object.keys(before)) {
    if (property in after) continue
    changes.push({ property: camelToKebabCssProperty(property), value: null })
  }
  return changes
}

/** Only the changes that SET a value — what an `insert`/`create` edit's full declaration bag is built from. */
function settableDeclarations(changes: readonly PropertyChange[]): Record<string, string> {
  const bag: Record<string, string> = {}
  for (const change of changes) {
    if (change.value !== null) bag[change.property] = change.value
  }
  return bag
}

/**
 * Diff each rule's EFFECTIVE declarations (see `effectiveStudioStyles`)
 * against the last synced baseline and produce the `kind: 'css'` edits for
 * rules with a real source, plus the changes that could not be written and
 * must therefore be reported.
 *
 * Three things happen per rule:
 *
 *   1. its unconditional declarations are diffed, in BOTH directions — a
 *      property that disappeared becomes an `op: 'unset'` edit (`style-03`;
 *      it used to become nothing at all, silently);
 *   2. each REAL context (a breakpoint or a condition, never the synthetic
 *      `studio` viewport) is diffed the same way and written into its own
 *      `@media` block, when `mediaQueryForContext` can name one;
 *   3. a context that is not a media query at all (`@container`, `@supports`)
 *      keeps the `unwritableContexts` refusal — reported, never dropped.
 */
export function collectStyleRuleEdits(
  styleRules: Record<string, StyleRule>,
  pages: readonly Page[] = [],
  contexts: StyleRuleContexts = {},
): StyleRuleEditPlan {
  const edits: StyleEditPayload[] = []
  const unmapped: UnmappedStyleRule[] = []
  const unwritableContexts: string[] = []
  const ruleIdsByNodeId: Record<string, string[]> = {}
  const pageIndex = buildClassPageIndex(pages)

  /** Records which rule an emitted edit's join key belongs to — see `StyleRuleEditPlan.ruleIdsByNodeId`. */
  const claim = (nodeId: string, ruleId: string): void => {
    const claimed = ruleIdsByNodeId[nodeId] ?? []
    if (!claimed.includes(ruleId)) claimed.push(ruleId)
    ruleIdsByNodeId[nodeId] = claimed
  }

  // `@keyframes` blocks first (W5-5). They are diffed on `rawCss` rather than
  // on a declaration bag, so they get their own collector — but they share
  // this plan, so one save carries a keyframe edit and the class edit that
  // references it together, and one refusal path reports both.
  const keyframes = collectKeyframesEdits(styleRules, pages)
  edits.push(...keyframes.edits)
  unmapped.push(...keyframes.unmapped)
  for (const [nodeId, ruleId] of Object.entries(keyframes.ruleIdByNodeId)) claim(nodeId, ruleId)

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

    const label = rule.selector || rule.name

    // W4-4 Phase B — a rule flattened out of a styled-component template.
    // Checked BEFORE the `.css` paths below because it can never have a
    // `styleRuleSources` entry (it reached the registry through `extraCss`),
    // so it would otherwise fall straight through to `unmapped` — which is
    // exactly what Phase A did, and is now wrong: the declarations are
    // hand-written in a `.tsx` this map names.
    const styled = getStudioStyledRuleSources()[ruleId]
    if (styled) {
      pushStyledEdits({ ruleId, rule, styled, label, contexts, edits, unmapped, claim })
      continue
    }

    const source = getStudioStyleRuleSources()[ruleId]

    /** One `(scope, property)` write, once a source is known to exist. */
    const pushScopedEdits = (changes: readonly PropertyChange[], atMedia: string | undefined): void => {
      if (!source) return
      for (const change of changes) {
        const nodeId = `css:${source.file}#${source.selector}#${atMedia ?? ''}#${change.property}`
        claim(nodeId, ruleId)
        edits.push(
          change.value === null
            ? {
                kind: 'css',
                op: 'unset',
                nodeId,
                file: source.file,
                selector: source.selector,
                property: change.property,
                ...(atMedia ? { atMedia } : {}),
              }
            : {
                kind: 'css',
                op: 'set',
                nodeId,
                file: source.file,
                selector: source.selector,
                property: change.property,
                value: change.value,
                ...(atMedia ? { atMedia } : {}),
              },
        )
      }
    }

    // --- real breakpoint/condition overrides (style-03) ----------------------
    for (const contextId of realContextIds(rule)) {
      const contextChanges = diffDeclarations(
        contextBaselineFor(ruleId, contextId),
        rule.contextStyles?.[contextId] ?? {},
      )
      if (contextChanges.length === 0) continue
      const atMedia = mediaQueryForContext(contextId, contexts)
      // A `@container`/`@supports` context, or one this document no longer
      // defines: `setDeclarationAtMedia` writes `@media` and nothing else, so
      // writing it would produce the wrong at-rule. Reported, never guessed.
      if (!atMedia) {
        if (!unwritableContexts.includes(label)) unwritableContexts.push(label)
        continue
      }
      if (!source) {
        // The rule's unconditional declarations have no home yet either; the
        // `insert`/`create` branch below is what has to run first. Reported
        // through `unmapped` by that branch, so nothing is said twice here.
        continue
      }
      pushScopedEdits(contextChanges, atMedia)
    }

    // --- unconditional declarations -----------------------------------------
    const changes = diffDeclarations(baselineFor(ruleId), effectiveStudioStyles(rule))
    if (changes.length === 0) continue

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
      // A brand-new rule has nothing on disk to REMOVE a property from, so
      // only the set half of the diff reaches an insert/create.
      const declarations = settableDeclarations(changes)
      if (Object.keys(declarations).length === 0) continue
      if (destination.kind === 'existing') {
        const nodeId = `css:insert:${destination.file}#${rule.selector}`
        claim(nodeId, ruleId)
        edits.push({
          kind: 'css',
          op: 'insert',
          nodeId,
          file: destination.file,
          selector: rule.selector,
          declarations,
        })
        continue
      }
      // `kind: 'create'` — no editable stylesheet exists yet; the server
      // invents one co-located with `destination.pageFile` and reports back
      // which file it made (`recordCreatedStylesheet`/`notifyCreatedStylesheets`
      // pick that up from the save response). `nodeId` carries the rule id
      // itself so the response can be joined back to it — see
      // `ruleIdFromCssCreateNodeId`.
      claim(`${CSS_CREATE_NODE_ID_PREFIX}${ruleId}`, ruleId)
      edits.push({
        kind: 'css',
        op: 'create',
        nodeId: `${CSS_CREATE_NODE_ID_PREFIX}${ruleId}`,
        pageFile: destination.pageFile,
        selector: rule.selector,
        declarations,
      })
      continue
    }
    pushScopedEdits(changes, undefined)
  }

  return { edits, unmapped, unwritableContexts, ruleIdsByNodeId }
}

/**
 * W4-4 Phase B — one styled rule's changes, split into the value edits that
 * can reach the user's template and the ones that cannot.
 *
 * ## Only a SET is a value edit
 *
 * A cleared declaration (`value === null`) is not a value change: writing it
 * means deleting a line from a template the user wrote, next to
 * interpolations whose position decides what the surrounding CSS means. Same
 * for a property the template never declared, which would mean adding one.
 * Both are reported through `unmapped` — the caller's existing “Style not
 * saved to source” toast, which is the right title for them — rather than
 * being silently dropped, the one outcome this whole module exists to
 * prevent. The server refuses them a second time by name if one ever reaches
 * it (`setStyledDeclaration`'s `declaration-not-in-template`); saying so here
 * is what stops the user waiting two seconds to find out.
 *
 * ## A real breakpoint IS writable here
 *
 * Unlike the `.css` path, a styled template's nested `@media` is part of the
 * same template, so an override under one writes through the same codemod
 * with the query attached. Only a context this document cannot name a `@media`
 * query for (`@container`/`@supports`) is unwritable, and it takes the same
 * `unmapped` report rather than `unwritableContexts` — the sentence a user
 * needs here is about the template, not about at-rule support.
 */
function pushStyledEdits(args: {
  ruleId: string
  rule: StyleRule
  styled: StyledRuleSource
  label: string
  contexts: StyleRuleContexts
  edits: StyleEditPayload[]
  unmapped: UnmappedStyleRule[]
  claim: (nodeId: string, ruleId: string) => void
}): void {
  const { ruleId, rule, styled, label, contexts, edits, unmapped, claim } = args
  const nodeId = styledEditNodeId(styled)

  const push = (changes: readonly PropertyChange[], atMedia: string | undefined): void => {
    for (const change of changes) {
      if (change.value === null) {
        unmapped.push({
          label,
          reason:
            `Clearing “${change.property}” would mean deleting a line from ${styled.componentName}'s styled template. ` +
            'Studio only changes values inside a template it did not write, so this stays on the canvas and will be ' +
            `lost on reload — remove the declaration in ${styled.file} instead.`,
        })
        continue
      }
      claim(nodeId, ruleId)
      edits.push({
        kind: 'styled',
        nodeId,
        className: styled.className,
        selector: rule.selector,
        property: change.property,
        value: change.value,
        ...(atMedia ? { atMedia } : {}),
      })
    }
  }

  for (const contextId of realContextIds(rule)) {
    const changes = diffDeclarations(contextBaselineFor(ruleId, contextId), rule.contextStyles?.[contextId] ?? {})
    if (changes.length === 0) continue
    const atMedia = mediaQueryForContext(contextId, contexts)
    if (!atMedia) {
      unmapped.push({
        label,
        reason:
          `${label} changed under a container or feature query. Studio writes an override into a styled template as ` +
          'a nested @media block only, so this stays on the canvas and will be lost on reload.',
      })
      continue
    }
    push(changes, atMedia)
  }

  push(diffDeclarations(baselineFor(ruleId), effectiveStudioStyles(rule)), undefined)
}
