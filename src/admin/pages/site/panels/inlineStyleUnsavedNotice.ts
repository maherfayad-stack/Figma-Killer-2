/**
 * inlineStyleUnsavedNotice — the missing half of `canWriteInlineStyleForModule`.
 *
 * That predicate is the ONE rule for "can this module's element carry a
 * `style=""` this editor writes?" — `base.*` and `alm.*` yes, `pkg.*` and
 * `studio.instance` no (a third-party package Studio knows nothing about, and
 * a local component call site rendered as a Fragment with no DOM box of its
 * own). `fsCodemodAdapter.saveSite` has always consulted it before emitting a
 * `kind: 'style'` edit.
 *
 * What it did with a `false` was DROP THE EDIT AND SAY NOTHING. The value was
 * already in `node.inlineStyles`, so the canvas rendered it, the save reported
 * success, and the next reload — which replaces each page wholesale with what
 * the parser just read off disk (`patchPages`) — restored the old value. The
 * user's report was exactly that shape: "why after applying different font in
 * the properties panel it gets back to this font again".
 *
 * `StyleSurface` does gate the OFFER for the single-selection inline composer
 * (`showInlineModuleLockedNotice`), but that is one entry point out of
 * several. `MultiInlineStyleComposer`'s write reach models only the
 * per-property `codeProps` locks, an agent tool writes through the store
 * directly, and any future surface starts unguarded. So the honest place for
 * the refusal is the same chokepoint the edit is dropped at — one message, at
 * the moment the write would have been attempted, for every path at once.
 * `classAssignmentUnsavedNotice.ts` is the same shape for the same reason.
 *
 * CLAUDE.md invariant 2: a write with no honest target is refused OUT LOUD.
 * Silence is the one outcome that loses the user's work without telling them.
 */
import { pushToast } from '@ui/components/Toast'
import { cssPropertyLabel } from './PropertiesPanel/cssControlTypes'

/** One node's dropped inline-style drift. */
export interface InlineStyleModuleRefusal {
  /** The node's display label (`PageNode.label`), or its id when it has none. */
  nodeLabel: string
  /** `PageNode.moduleId` — the reason, named. */
  moduleId: string
  /** camelCase CSS properties that would have been written or removed. */
  properties: readonly string[]
}

const MAX_NAMED = 3

/**
 * Why this module can't take a `style=""` the editor writes, in the user's
 * words. A design-system component (`alm.*`) is deliberately absent: it CAN,
 * and never reaches here.
 */
function describeModule(moduleId: string): string {
  if (moduleId === 'studio.instance') {
    return 'it is a call site of one of your own components, which renders no box of its own — its styles live in that component’s file, where they would change every instance'
  }
  return `it is a ${moduleId} component from a package, and nothing tells Studio that it forwards a style prop to the element you can see`
}

function describeRefusal(refusal: InlineStyleModuleRefusal): string {
  const names = refusal.properties.map((property) => cssPropertyLabel(property))
  return `${refusal.nodeLabel} (${names.join(', ')})`
}

/**
 * Warn that an inline-style change on one or more nodes was dropped because
 * the node's module has no `style=""` target in the user's source. No-ops on
 * an empty list — mirrors every other refusal toast in this codebase.
 */
export function notifyInlineStyleUnsaved(refusals: readonly InlineStyleModuleRefusal[]): void {
  if (refusals.length === 0) return

  const named = refusals.slice(0, MAX_NAMED).map(describeRefusal)
  const remaining = refusals.length - named.length
  const list = remaining > 0 ? `${named.join('; ')}; and ${remaining} more` : named.join('; ')

  pushToast({
    kind: 'warning',
    title: "Style change won't be saved",
    body:
      `${list}. This element takes no style of its own here — ${describeModule(refusals[0].moduleId)}. ` +
      `Assign a CSS class to it, or change the design-system token, instead — otherwise ` +
      `${refusals.length === 1 ? 'it' : 'these'} will revert the next time this page loads.`,
    location: 'site-editor',
  })
}
