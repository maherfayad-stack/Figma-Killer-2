/**
 * classCssWritability — the ONE answer, computed BEFORE the user types, to
 * "can a declaration typed into this class reach the user's disk?".
 *
 * ## Why this is its own module
 *
 * `resolveClassCssEditability` used to be a private helper at the bottom of
 * `StyleSurface.tsx`, feeding exactly one consumer: `StyleTargetChip`'s
 * tooltip. That was enough to *explain* the outcome and not enough to *act*
 * on it — every property row of an unwritable class stayed fully editable,
 * so the honest sequence was: type a value, watch the canvas update, wait
 * ~2 s for autosave, and only then get a toast saying nothing was written
 * (`styleRuleWriteback.ts`'s `unmapped` list). A control that accepts an
 * edit it knows cannot land is the panel's version of the `[object Object]`
 * input: it does not merely fail, it invites the failure.
 *
 * So the predicate moved out of the component and gained a second consumer:
 * `StyleWriteLockContext`, which `StyleSurface` provides around the CLASS
 * block only and every `ClassPropertyRow` beneath it reads to render
 * disabled. Same fact, stated once, used by the tooltip and by the controls.
 *
 * ## The predicate is `styleRuleWriteback.ts`'s, not a second opinion
 *
 * Both branches below are the client half of the save path, called with the
 * same inputs the save itself uses:
 *
 *   - a rule WITH a `styleRuleSources` entry is classified by
 *     `classifyStylesheetEditability` — the identical call
 *     `server/handlers/studioCssWriteback.ts` makes before touching a file;
 *   - a rule WITHOUT one goes through `resolveCssInsertDestination` — the
 *     identical call `collectStyleRuleEdits` makes to decide between an
 *     `insert`, a `create`, and a refusal.
 *
 * Nothing here re-derives a rule of its own. The one invariant this module
 * used to restate by hand — "only an editor-authored rule is an insert
 * candidate" — is now `isImportedStyleRuleId` from `@core/page-tree`, the
 * same function `styleRuleWriteback.ts`'s own gate is built on. The former
 * copy (`!classId.startsWith('sc-')`) carried a doc comment admitting it was
 * a duplicate; a duplicated invariant with a comment apologising for itself
 * is still a duplicated invariant, and this one guarded a claim about
 * writing to a user's repository.
 *
 * ## Why the lock is gated on a Studio session
 *
 * `getStudioStyleRuleSources()` is `{}` outside Studio — the DB-backed
 * editor has no `.tsx`/`.css` files on disk to map to — so EVERY class there
 * resolves to `unmapped`. That is the correct answer to "which source file
 * does this write to" (none — it writes to the site document) and exactly
 * the wrong basis for disabling a control: nothing is lost, the class saves
 * normally. `classCssWriteLockReason` therefore takes `studioSession` and
 * only locks an `unmapped` class inside Studio, where "unmapped" genuinely
 * means "your keystrokes will not survive a reload".
 *
 * `compiled` needs no such gate: it is only reachable through a
 * `styleRuleSources` entry, which only a Studio load ever produces.
 */
import type { StyleRule } from '@core/page-tree'
import { isImportedStyleRuleId } from '@core/page-tree'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { getStudioStyleRuleSources, resolveCssInsertDestination } from '@site/studio/styleRuleWriteback'
import type { ClassCssEditability } from './StyleTargetChip'

/**
 * The active class's write-back tier, resolved from the current project's
 * `styleRuleSources` map (WS-6.3's `StyleRule.id -> (file, selector)`) plus
 * `classifyStylesheetEditability` and, when no source exists yet,
 * `resolveCssInsertDestination` (Track B1/B1b). See `StyleTargetChip`'s doc
 * for what each of the five outcomes means and writes.
 */
export function resolveClassCssEditability(cls: StyleRule): ClassCssEditability {
  const source = getStudioStyleRuleSources()[cls.id]
  if (source) {
    const editability = classifyStylesheetEditability(source.file)
    return editability.kind === 'plain-css'
      ? { kind: 'plain-css', file: source.file }
      : { kind: 'compiled', reason: editability.reason }
  }
  // An IMPORTED rule with no source has a real reason to stay unmapped
  // (Tailwind's generated utilities, a Sass/PostCSS build, a CSS Modules
  // compile) and must never appear to gain a fabricated write target.
  if (isImportedStyleRuleId(cls.id)) return { kind: 'unmapped' }
  const destination = resolveCssInsertDestination(cls)
  if (!destination.ok) return { kind: 'unmapped', reason: destination.message }
  return destination.kind === 'existing'
    ? { kind: 'will-create-existing', file: destination.file }
    : { kind: 'will-create-new-stylesheet', pageFile: destination.pageFile }
}

/**
 * The wording for an `unmapped` class that carried no more specific reason of
 * its own — an imported rule Studio never mapped to a hand-authored block.
 * Deliberately names the two real causes rather than saying "not supported":
 * a user whose whole project is Tailwind needs to know the class itself is
 * the artefact, not that Studio is broken.
 */
export const UNMAPPED_CLASS_LOCK_REASON =
  'Compiled or generated class — Studio has no hand-authored CSS block to edit for it '
  + '(a Tailwind utility, a build output, or a rule it could not map back to a file).'

/**
 * Why a declaration typed into this class cannot reach disk, or `null` when it
 * can (now, or on its first edit — the two `will-create-*` tiers DO write).
 *
 * `undefined` editability means no class is open for editing at all, which is
 * not a lock: there is simply nothing to lock.
 */
export function classCssWriteLockReason(
  editability: ClassCssEditability | undefined,
  options: { studioSession: boolean },
): string | null {
  if (!editability) return null
  if (editability.kind === 'compiled') return editability.reason
  if (editability.kind === 'unmapped') {
    if (!options.studioSession) return null
    return editability.reason ?? UNMAPPED_CLASS_LOCK_REASON
  }
  return null
}
