/**
 * refusalToasts — how `saveSite` TELLS a user about a refusal: one report per
 * distinct refusal per session, for every named decline the save loop can
 * produce (`style-02`/`style-02`/`style-02`).
 *
 * Four reporters, one de-dupe: the server's per-edit refusals
 * (`StudioEditBatchResult.refusals` — `detach`/`swap`/`css`/`class`), the
 * client's own class-TOKEN refusals (`classNameWriteback.ts`), the classes
 * whose declarations have no stylesheet to land in ever
 * (`styleRuleWriteback.ts`'s `unmapped`), and the at-rule contexts Studio
 * cannot write. (A new class's DESTINATION is not among them since P3-C: the
 * editor chooses it, or creates the stylesheet.) Split out of
 * `fsCodemodAdapter.ts` for the `module-size-budgets` ceiling and because
 * "what a refusal reads like to a person" is a different reason to change
 * than "which edits to send".
 *
 * ## Why the de-dupe exists
 *
 * A refusal used to be reported exactly once because the diff baseline
 * advanced past it: the edit was sent, refused, toasted, and then the
 * baseline adopted the value that never reached disk, so nothing was ever
 * re-sent. That is a fine way to stop a repeating toast and a terrible way to
 * treat a user's work — retyping the same value produced "no change" and the
 * edit was never attempted again (see `styleRuleWriteback.ts`'s
 * `commitBaseline` `refusedRuleIds`, and `loadedValuesBaseline.ts`'s
 * `commitClassIdsBaseline` `refusedNodeIds`).
 *
 * With the baseline held back, the edit IS re-sent on the next save, and the
 * refusal comes back with it. The right thing to de-duplicate is therefore the
 * TOAST, not the attempt. Keyed by the caller's own stable key (kind + target
 * + reason), reset on every `loadSite` — so a refusal whose cause the user
 * then fixes, and which later recurs, is reported again in the next session,
 * and a genuinely different refusal is never swallowed.
 *
 * Deliberately a module-level set rather than store state: it is per-session
 * UI noise control with no undo, no persistence, and no renderer — the same
 * shape and the same reason as `studioRawCssStores.ts`'s tiny external stores.
 *
 * ## Warnings, each with its remedy (WB-13)
 *
 * Every report here is a `warning`, never an `error`. A refusal is the editor
 * keeping a promise — it would not write something it could not write
 * honestly — and the file is exactly as it was; nothing broke. Where a refusal
 * has a place in the code the person can go and fix, the warning carries that
 * one click ("Open in code"). A red card is for a failure the user did not
 * cause and cannot act on, and a save-time refusal is neither.
 */
import { decodeSourceNodeId } from '@core/page-tree'
import { pushToast, type ToastInput } from '@ui/components/Toast'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import { useEditorStore } from '@site/store/store'
import type { ClassTokenRefusal } from './classNameWriteback'
import type { StyleRuleEditPlan, UnmappedStyleRule } from './styleRuleWriteback'

/** One `StudioEditBatchResult.refusals` entry — the server's named per-edit declines. */
export interface StudioEditRefusalReport {
  nodeId: string
  kind: string
  reason: string
  message: string
}

/**
 * Every refusal is a NAMED, expected outcome (Card uses a hook, the new name
 * would shadow a binding, this stylesheet is a compiled build artefact, this
 * element holds more than text …), so it gets a warning carrying the actual
 * reason. WB-12 — every kind refuses by name now, so there is no generic
 * "no writable location" message left to fall back on.
 */
const REFUSAL_TITLES: Record<string, string> = {
  detach: 'Detach refused',
  swap: 'Swap refused',
  css: 'Style not saved to source',
  class: 'Class change not saved to source',
  style: 'Inline style not saved to source',
  // WB-11 — `binding-overwrite`: the attribute holds code, and a literal
  // written over it would delete the binding.
  prop: 'Property not saved to source',
  // W4-4 Phase B — a declaration edit that could not land inside a
  // styled-component template (an interpolated value, a covering shorthand, a
  // declaration written in a spliced mixin).
  styled: 'Style not saved to source',
  text: 'Text not saved to source',
  literal: 'Copy not saved to source',
  tag: 'Tag not changed in source',
  asset: 'Image not saved to source',
}

/** A refusal whose REASON tells the story better than its kind. */
const REASON_TITLES: Record<string, string> = {
  // WB-24 — any kind refuses this way, and the file, not the edit, is the story.
  'syntax-error': 'Not saved: the file has a syntax error',
  'write-failed': 'Not saved to source',
}

/**
 * The one-click remedy for a refusal: open the code it names. `null` when the
 * refusal names no source position (a `css` edit's synthetic id) — then the
 * sentence is the whole answer.
 */
function openInCodeRemedy(nodeId: string): ToastInput['action'] {
  const target = decodeSourceNodeId(nodeId)
  if (!target) return undefined
  return { label: 'Open in code', onSelect: () => jumpToSource(target) }
}

let seen = new Set<string>()

/** Cleared by `loadSite` — a fresh document is a fresh set of refusals. */
export function resetRefusalToasts(): void {
  seen = new Set()
}

/** Pushes `toast` unless an identical `key` has already been reported this session. */
function toastOnce(key: string, toast: ToastInput): void {
  if (seen.has(key)) return
  seen.add(key)
  pushToast(toast)
}

/**
 * Reports every server-side per-edit refusal from one save response.
 *
 * Keyed on the refusal's SOURCE TARGET, not its node id. Every instance of a
 * shared component writes back to one location, and WB-7's merge reports one
 * refused write once per instance that contributed to it (so each instance's
 * baseline is held back) — that is one refusal to the user, not N toasts.
 */
export function reportEditRefusals(refusals: readonly StudioEditRefusalReport[]): void {
  for (const refusal of refusals) {
    const target = decodeSourceNodeId(refusal.nodeId)
    const targetKey = target ? `${target.rel}:${target.line}:${target.col}` : refusal.nodeId
    const action = openInCodeRemedy(refusal.nodeId)
    toastOnce(`${refusal.kind}::${targetKey}::${refusal.reason}`, {
      kind: 'warning',
      title: REASON_TITLES[refusal.reason] ?? REFUSAL_TITLES[refusal.kind] ?? 'Edit refused',
      body: refusal.message,
      ...(action ? { action } : {}),
    })
  }
}

/**
 * `style-02` — a class whose TOKEN could not be resolved honestly (a
 * styled-component's synthetic class, which has no token at all). The node's
 * `classIds` baseline is held back by the caller, so the assignment is
 * retried on the next save rather than lost. A class waiting on a stylesheet
 * this same save creates is NOT reported here (ERR-15): it attaches on the
 * save that follows at once.
 */
export function reportClassTokenRefusals(refusals: readonly ClassTokenRefusal[]): void {
  for (const refusal of refusals) {
    toastOnce(`class-token::${refusal.nodeLabel}::${refusal.className}::${refusal.reason}`, {
      kind: 'warning',
      title: 'Class not attached in source',
      body: `${refusal.className} on ${refusal.nodeLabel}: ${refusal.message}`,
    })
  }
}

/**
 * `style-02` — each unmapped class carries its OWN reason (or none), so the
 * specific sentence is the toast BODY. Concatenating it into the generic lead
 * (as this used to) produced a self-contradictory sentence: the lead said "no
 * hand-editable CSS file in this project" while the appended reason said
 * "Studio found 4 candidate stylesheets".
 *
 * That second sentence no longer arrives here at all — P3-C's ERR-14 made the
 * destination of a new class something the editor chooses, never a refusal.
 * What is left in this list is the genuinely permanent tier: a Tailwind
 * utility, a compiled build artefact, a styled template Studio will not
 * rewrite.
 */
function reportUnmappedStyleRules(unmapped: readonly UnmappedStyleRule[]): void {
  for (const entry of unmapped) {
    toastOnce(`css-unmapped::${entry.label}::${entry.reason ?? ''}`, {
      kind: 'warning',
      title: 'Style not saved to source',
      body: entry.reason
        ? `${entry.label}: ${entry.reason}`
        : `${entry.label} has no hand-editable CSS file in this project (a generated utility class, a compiled ` +
          'build artefact, or a stylesheet syntax Studio does not write), so this change stays on the canvas ' +
          'only and will be lost on reload. Style the element instead to write it to source.',
      // WB-30 (P3-C, partial) — the remedy the sentence names, one click away:
      // the same inline-style target `ClassCssLockedNotice`'s button and the
      // Element chip switch to. It does not MOVE the declarations already typed
      // into the class; that is still the user's next edit.
      action: { label: 'Style the element instead', onSelect: () => useEditorStore.getState().setInlineStyleEditing(true) },
    })
  }
}


/**
 * Every way one save's CSS plan declined: a permanently unmapped class and an
 * unwritable at-rule context, each a warning. The single entry point `saveSite`
 * calls, because "which surface does this refusal belong on" is this module's
 * decision to make and the adapter's only job is to hand over the plan.
 *
 * P3-C — there used to be a third family, a new class's DESTINATION, which
 * opened a "Which stylesheet should this class live in?" `RefusalDialog`
 * ~2 s after the first keystroke (ERR-14) or toasted "Style not saved to
 * source" for a project with no stylesheet yet (ERR-15). The planner now
 * chooses, or creates the first stylesheet, so nothing is asked.
 */
export function reportStyleRulePlanRefusals(plan: StyleRuleEditPlan): void {
  reportUnmappedStyleRules(plan.unmapped)
  reportUnwritableContexts(plan.unwritableContexts)
}

/**
 * Whether this plan did anything the CSS diff baseline must be advanced past
 * — sent an edit, or declined one. A decline counts: the caller holds the
 * refused rules back by id (`refusedRuleIds`), and every OTHER rule in the
 * document still has to move on, or the next save re-sends writes that
 * already landed.
 */
export function styleRulePlanTouchedSomething(plan: StyleRuleEditPlan): boolean {
  return (
    plan.edits.length > 0 ||
    plan.unmapped.length > 0 ||
    plan.unwritableContexts.length > 0
  )
}

/**
 * `style-03` — a context Studio genuinely cannot write. Every breakpoint and
 * every `media`/`container`/`supports` condition goes to disk inside its own
 * block (P3-C, WB-31 — `@container`/`@supports` used to land here). What is
 * left is an override under a context the document no longer defines: there
 * is no block to name, and guessing one would put the declaration under a
 * condition the user did not ask for — worse than saying so.
 */
function reportUnwritableContexts(labels: readonly string[]): void {
  for (const label of labels) {
    toastOnce(`css-context::${label}`, {
      kind: 'warning',
      title: 'Override not saved to source',
      body:
        `${label} changed under a breakpoint or condition this project no longer defines, so there is no block ` +
        'to write it into and it stays on the canvas only.',
    })
  }
}
