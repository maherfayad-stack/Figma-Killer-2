/**
 * autosaveSchedule — the autosave CADENCE policy `usePersistence.ts`'s
 * debounce timer runs against: how long to wait, how long a continuous
 * burst may keep deferring, and how to skip the wait entirely once a field
 * visibly settles.
 *
 * Split out of `usePersistence.ts` (`speed-02`'s module-size-budget fix) —
 * every export here is a pure function (or, for `flushAutosave`, a thin
 * point-in-time store read + an existing DOM-event dispatch), independent of
 * the hook's timers/refs/effects. `usePersistence.ts` still owns the
 * mechanical wiring: arming/clearing the `setTimeout`, the single-flight
 * save queue, the retry ladder.
 */
import { useEditorStore } from '@site/store/store'
import { readAutoSaveDelayMs } from '@site/preferences/editorPreferences'
import { requestEditorSave } from '@admin/state/adminEvents'

/**
 * Resolve the auto-save idle delay: an explicit `overrideMs` (Studio's fixed,
 * snappy cadence) wins; otherwise fall back to the user's CMS preference.
 * Pulled out as a pure function so the precedence rule is unit-testable
 * without mounting the hook or waiting on real timers.
 */
export function resolveAutoSaveDelayMs(overrideMs?: number): number {
  return overrideMs ?? readAutoSaveDelayMs()
}

/**
 * How long a continuous edit burst may keep deferring the autosave, as a
 * multiple of the idle delay.
 *
 * A pure trailing debounce never fires while the user keeps typing, which for
 * Studio means the `.tsx` on disk can lag the canvas indefinitely — the exact
 * failure mode the fixed, snappy `STUDIO_AUTOSAVE_DELAY_MS` exists to avoid.
 * The cap converts "never" into "at worst every 4 × the idle delay" (1 s in
 * Studio post-`speed-02`, the user's own configured multiple in the CMS),
 * which is still a long burst but is bounded. 4 was chosen so that a save
 * mid-burst is rare enough not to feel like the editor is writing over your
 * typing, and near enough that no realistic burst outruns it.
 */
export const AUTOSAVE_MAX_DEFERRAL_MULTIPLE = 4

/**
 * The delay the NEXT autosave tick should use: the full idle delay, unless
 * the burst has already deferred long enough to exhaust its budget, in which
 * case whatever is left of it (never negative — an exhausted budget fires on
 * the next tick).
 *
 * Pure so the cap is unit-testable without mounting the hook or waiting on
 * real timers, exactly like `resolveAutoSaveDelayMs` above.
 */
export function nextAutoSaveDelayMs(idleDelayMs: number, deferredForMs: number): number {
  const remainingBudget = idleDelayMs * AUTOSAVE_MAX_DEFERRAL_MULTIPLE - deferredForMs
  return Math.max(0, Math.min(idleDelayMs, remainingBudget))
}

/**
 * `speed-02`'s flush half: request the SAME immediate save
 * `EDITOR_SAVE_REQUEST_EVENT` already triggers for "Save as layout" and deep
 * links, but only when there is something dirty to ship. A field the user
 * blurs, presses Enter in, or releases a scrub drag over has JUST landed a
 * store mutation — calling this right after (see `PropertiesPanel.tsx`'s
 * `onBlur`/`onKeyDown`/`onPointerUp`) writes it to disk without waiting out
 * even the 250ms trailing debounce.
 *
 * Deliberately NOT wired into every store mutation or into `commitApi.ts`:
 * most CSS-property text fields commit on every keystroke (there is no
 * separate preview channel for them), and flushing on every keystroke would
 * turn the debounce back into "one save per keystroke" — exactly what
 * `speed-02`'s "one save per burst" requirement rules out. The guard here
 * (`hasUnsavedChanges`) also means a stray blur/Enter/pointerup elsewhere in
 * the panel — a button, a non-editing keypress, clicking away with nothing
 * changed — is a no-op rather than an empty save request.
 */
export function flushAutosave(): void {
  if (useEditorStore.getState().hasUnsavedChanges) requestEditorSave()
}
