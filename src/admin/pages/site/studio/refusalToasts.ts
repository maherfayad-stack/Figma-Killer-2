/**
 * refusalToasts — how `saveSite` TELLS a user about a refusal: one toast per
 * distinct refusal per session, for every named decline the save loop can
 * produce (`style-02`/`style-02`/`style-02`).
 *
 * Three reporters, one de-dupe: the server's per-edit refusals
 * (`StudioEditBatchResult.refusals` — `detach`/`swap`/`css`/`class`), the
 * client's own class-TOKEN refusals (`classNameWriteback.ts`), and the classes
 * whose declarations have no stylesheet to land in
 * (`styleRuleWriteback.ts`'s `unmapped`). Split out of `fsCodemodAdapter.ts`
 * for the `module-size-budgets` ceiling and because "what a refusal reads like
 * to a person" is a different reason to change than "which edits to send".
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
import { pushToast, type ToastInput } from '@ui/components/Toast'
import type { ClassTokenRefusal } from './classNameWriteback'
import type { UnmappedStyleRule } from './styleRuleWriteback'

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
 */
export function reportUnmappedStyleRules(unmapped: readonly UnmappedStyleRule[]): void {
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
 * `style-03` — a context Studio genuinely cannot write. A breakpoint or a
 * `kind: 'media'` condition now goes to disk through `setDeclarationAtMedia`;
 * what is left is `@container` / `@supports`, which are a different at-rule
 * entirely. Writing one as `@media` would put the declaration under a
 * condition the user did not ask for — worse than saying so.
 */
export function reportUnwritableContexts(labels: readonly string[]): void {
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
