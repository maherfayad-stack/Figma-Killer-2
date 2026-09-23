/**
 * refusalToasts — how `saveSite` TELLS a user about a refusal: one report per
 * distinct refusal per session, for every named decline the save loop can
 * produce (`style-02`/`style-02`/`style-02`).
 *
 * Four reporters, one de-dupe: the server's per-edit refusals
 * (`StudioEditBatchResult.refusals` — `detach`/`swap`/`css`/`class`), the
 * client's own class-TOKEN refusals (`classNameWriteback.ts`), the classes
 * whose declarations have no stylesheet to land in ever
 * (`styleRuleWriteback.ts`'s `unmapped`), and Z8's destination refusals — the
 * one family here that is a QUESTION rather than a statement, and therefore
 * the one that opens a `RefusalDialog` instead of a toast. Split out of
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
 */
import { explainCssRuleConstraint } from '@core/page-tree'
import { pushToast, type ToastInput } from '@ui/components/Toast'
import type { StructuralRefusalDialogState } from '@site/store/slices/structuralRefusalDialogState'
import type { ClassTokenRefusal } from './classNameWriteback'
import type { CssDestinationRefusal, StyleRuleEditPlan, UnmappedStyleRule } from './styleRuleWriteback'

/** One `StudioEditBatchResult.refusals` entry — the server's named per-edit declines. */
export interface StudioEditRefusalReport {
  nodeId: string
  kind: string
  reason: string
  message: string
}

/**
 * A `detach`/`swap`/`css`/`class` refusal is a NAMED, expected outcome (Card
 * uses a hook, the new name would shadow a binding, this stylesheet is a
 * compiled build artefact, …), so it gets a toast carrying the actual reason
 * rather than folding into the generic "no writable location" message, which
 * would be actively misleading — the location WAS writable; the codemod
 * declined on purpose.
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

/** Reports every server-side per-edit refusal from one save response. */
export function reportEditRefusals(refusals: readonly StudioEditRefusalReport[]): void {
  for (const refusal of refusals) {
    toastOnce(`${refusal.kind}::${refusal.nodeId}::${refusal.reason}`, {
      kind: 'error',
      title: REFUSAL_TITLES[refusal.kind] ?? 'Edit refused',
      body: refusal.message,
    })
  }
}

/**
 * `style-02` — a class whose TOKEN could not be resolved honestly (the
 * stylesheet the server is about to create in this same save, a destination
 * Studio refuses to guess). The node's `classIds` baseline is held back by
 * the caller, so the assignment is retried on the next save rather than lost.
 */
export function reportClassTokenRefusals(refusals: readonly ClassTokenRefusal[]): void {
  for (const refusal of refusals) {
    toastOnce(`class-token::${refusal.nodeLabel}::${refusal.className}::${refusal.reason}`, {
      kind: 'error',
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
 * Z8 — that second sentence no longer arrives here at all. A class refused
 * because its DESTINATION is ambiguous is not unmapped; it is unanswered, and
 * it goes to `presentCssDestinationRefusals` instead. What is left in this
 * list is the genuinely permanent tier: a Tailwind utility, a compiled build
 * artefact, a styled template Studio will not rewrite.
 */
function reportUnmappedStyleRules(unmapped: readonly UnmappedStyleRule[]): void {
  for (const entry of unmapped) {
    toastOnce(`css-unmapped::${entry.label}::${entry.reason ?? ''}`, {
      kind: 'error',
      title: 'Style not saved to source',
      body: entry.reason
        ? `${entry.label}: ${entry.reason}`
        : `${entry.label} has no hand-editable CSS file in this project (a generated utility class, a compiled ` +
          'build artefact, or a stylesheet syntax Studio does not write), so this change stays on the canvas ' +
          'only and will be lost on reload. Style the element instead to write it to source.',
    })
  }
}

/**
 * The title `RefusalDialog` shows for a destination the user has to choose.
 * Phrased as the question it is — the dialog's body carries the reason, and
 * its buttons are the answers.
 */
const CSS_DESTINATION_DIALOG_TITLE = 'Which stylesheet should this class live in?'

/**
 * Z8 — a brand-new class whose first declarations had no single honest
 * stylesheet to land in.
 *
 * **`ambiguous-stylesheet` is a CHOICE, not a toast.** N hand-editable
 * stylesheets exist and every one of them is a real write target; the refusal
 * carries all of them, so this opens `RefusalDialog` with one remedy per file
 * (`choose-stylesheet`, dispatched by `constraintActions.ts`). Picking one
 * pins the destination and re-issues the save — the declarations the user
 * already typed are still in the diff, because the caller holds this rule's
 * baseline back. Reporting that as a red toast, as this used to, threw a
 * question the user could answer in one click into a sentence they could only
 * read.
 *
 * `no-editable-stylesheet` keeps a toast, and that is not an oversight: it
 * means there were ZERO candidates and neither the class nor the page on
 * screen names a file to co-locate a new one with. There is nothing to choose
 * between, so a dialog would be a modal with no answer in it — exactly the
 * split `presentStructuralRefusal` already makes between a refusal with
 * remedies and a terminal one.
 *
 * De-duped through the same per-session `toastOnce` key as every other
 * refusal here, for a reason specific to this one: the held-back baseline
 * means the refusal RECURS on every autosave tick until it is answered. An
 * un-deduped dialog would reopen itself every two seconds, including over the
 * top of the user answering it.
 */
function presentCssDestinationRefusals(
  refusals: readonly CssDestinationRefusal[],
  openDialog: (dialog: StructuralRefusalDialogState) => void,
): void {
  for (const refusal of refusals) {
    const key = `css-destination::${refusal.ruleId}::${refusal.reason}::${refusal.candidates.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const constraint = explainCssRuleConstraint(refusal.reason, `${refusal.label}: ${refusal.message}`, {
      ruleId: refusal.ruleId,
      candidates: refusal.candidates,
    })
    if (refusal.candidates.length > 0) {
      openDialog({ title: CSS_DESTINATION_DIALOG_TITLE, constraint })
      continue
    }
    pushToast({
      kind: 'error',
      title: 'Style not saved to source',
      body: constraint.explanation,
    })
  }
}

/**
 * Every way one save's CSS plan declined, each told in the shape it deserves:
 * a permanently unmapped class and an unwritable at-rule context toast, a
 * destination question opens a dialog. The single entry point `saveSite`
 * calls, because "which surface does this refusal belong on" is this module's
 * decision to make and the adapter's only job is to hand over the plan.
 */
export function reportStyleRulePlanRefusals(
  plan: StyleRuleEditPlan,
  openDialog: (dialog: StructuralRefusalDialogState) => void,
): void {
  reportUnmappedStyleRules(plan.unmapped)
  presentCssDestinationRefusals(plan.destinationRefusals, openDialog)
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
    plan.destinationRefusals.length > 0 ||
    plan.unwritableContexts.length > 0
  )
}

/**
 * `style-03` — a context Studio genuinely cannot write. A breakpoint or a
 * `kind: 'media'` condition now goes to disk through `setDeclarationAtMedia`;
 * what is left is `@container` / `@supports`, which are a different at-rule
 * entirely. Writing one as `@media` would put the declaration under a
 * condition the user did not ask for — worse than saying so.
 */
function reportUnwritableContexts(labels: readonly string[]): void {
  for (const label of labels) {
    toastOnce(`css-context::${label}`, {
      kind: 'error',
      title: 'Override not saved to source',
      body:
        `${label} changed under a container or feature query. Studio writes breakpoint overrides as @media ` +
        'blocks, and cannot yet write @container or @supports, so this override stays on the canvas only and ' +
        'will be lost on reload.',
    })
  }
}
