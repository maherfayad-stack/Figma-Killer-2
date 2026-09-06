/**
 * constraintActions — the ONE place an `EditConstraintAction`'s `kind` becomes
 * a thing that runs.
 *
 * `EditConstraint` is engine-authored and store-free by design
 * (`src/core/page-tree/editConstraint.ts`): it can NAME a way forward
 * ("Detach or edit the component definition", "Open the array in code") but
 * cannot dispatch one, because `@core/page-tree` has no editor store and must
 * not grow one. This module is the other half — the editor-side table that
 * turns each `kind` into a handler, so a refusal rendered in a panel, a
 * context menu and a toast all offer the SAME working button instead of three
 * surfaces each deciding what "detach" means.
 *
 * **A kind with no honest handler returns `null`, and the caller renders the
 * label as plain text.** That is the point of the taxonomy: some ways forward
 * are instructions to the user ("Drag them one by one"), not commands the
 * editor can execute for them. Inventing a handler for those would be a button
 * that does the wrong thing — worse than a sentence that does nothing.
 *
 * Wired today:
 *   - anything carrying a `target` (`jump-to-source`, `edit-array`) → opens
 *     that file in the code panel, through the caller's `openSource`
 *   - `detach` / `extract` → the real `studio.instance` codemods the
 *     Properties panel's Component section already dispatches
 *
 * Deliberately NOT wired: `select-container` (three different refusals share
 * that kind and only one of them means "select something"), `promote-tier1`
 * (no refusal emits it yet), `style-inline-instead` and `preview-branch` (the
 * surfaces that own those flows are not the ones that render a refusal).
 *
 * **Lives beside the store, not beside the component that renders it**, and
 * takes `openSource` as context rather than importing `jumpToSource`: a
 * refused structural gesture is detected inside a store action, so the store
 * has to reach this table — and nothing in the store's import graph may import
 * the composed store back (`no-circular-dependencies.test.ts`). Component call
 * sites pass `jumpToSource`; the store passes its own `openSourceFile` bound
 * to its `get()`.
 */
import type { EditConstraint, EditConstraintAction } from '@core/page-tree'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { detachInstance, extractInstanceCopy } from '@site/studio/studioSaveRequests'
import type { SourceOrigin } from './openSourceFile'

/** What a runnable action needs beyond the action itself. */
export interface ConstraintActionContext {
  /**
   * The node the refusal is about. `detach` / `extract` act on one specific
   * call site, so without it those two stay un-runnable rather than guessing.
   */
  nodeId?: string
  /**
   * How to open a file in the code panel. Absent means no caller can open one
   * here, so a `target`-carrying action stays un-runnable and renders as text
   * — the same honesty rule as every other unwireable kind.
   */
  openSource?: (origin: SourceOrigin) => void
}

/** `Header.tsx:42` — the origin, short enough to sit inside a button label. */
export function constraintOriginLabel(origin: SourceOrigin): string {
  const fileName = origin.rel.split('/').pop() ?? origin.rel
  return `${fileName}:${origin.line}`
}

/**
 * The handler for `action`, or `null` when this action is an instruction to
 * the user rather than a command the editor can run. Callers render the
 * `null` case as plain text — see this module's doc.
 */
export function resolveConstraintAction(
  action: EditConstraintAction,
  context: ConstraintActionContext = {},
): (() => void) | null {
  const openSource = context.openSource
  if (action.target && openSource) {
    const target = action.target
    return () => openSource(target)
  }
  if (action.kind === 'detach' && context.nodeId !== undefined) {
    const nodeId = context.nodeId
    return () => void runInstanceCodemod('Detach', () => detachInstance(nodeId))
  }
  if (action.kind === 'extract' && context.nodeId !== undefined) {
    const nodeId = context.nodeId
    return () => void runInstanceCodemod('Duplicate', () => extractInstanceCopy(nodeId))
  }
  return null
}

/**
 * The one way forward a single-action surface can offer — a toast, which has
 * room for exactly one button. The first action with a real handler wins;
 * failing that, the constraint's own `origin`, which is always openable.
 * `undefined` when the refusal is genuinely terminal.
 */
export function constraintPrimaryAction(
  constraint: EditConstraint,
  context: ConstraintActionContext = {},
): { label: string; onSelect: () => void } | undefined {
  for (const action of constraint.actions) {
    const run = resolveConstraintAction(action, context)
    if (run) return { label: action.label, onSelect: run }
  }
  const origin = constraint.origin
  const openSource = context.openSource
  if (origin && openSource) {
    return { label: `Open ${constraintOriginLabel(origin)}`, onSelect: () => openSource(origin) }
  }
  return undefined
}

/**
 * The constraint as toast body text: the engine's sentence, then any way
 * forward the editor CANNOT run as a button, since a sentence is the only
 * place left to say it. The runnable one becomes the toast's action instead
 * (`constraintPrimaryAction`) and is deliberately not repeated here.
 */
export function constraintToastBody(
  constraint: EditConstraint,
  context: ConstraintActionContext = {},
): string {
  const advice = constraint.actions
    .filter((action) => resolveConstraintAction(action, context) === null)
    .map((action) => (action.label.endsWith('.') ? action.label : `${action.label}.`))
  return [constraint.explanation, ...advice].join(' ')
}

/**
 * Both instance codemods answer the same three ways — threw, refused with its
 * own sentence, or landed — and all three are the user's business, so they
 * share one reporting shape instead of two near-identical try/catch blocks.
 */
async function runInstanceCodemod(
  gesture: 'Detach' | 'Duplicate',
  run: () => Promise<{ ok: boolean; message?: string }>,
): Promise<void> {
  try {
    const result = await run()
    if (!result.ok) {
      pushToast({
        kind: 'warning',
        title: `${gesture} refused`,
        body: result.message,
        location: 'site-editor',
        durationMs: null,
      })
    }
  } catch (err) {
    console.error(`[ConstraintNotice] ${gesture} failed:`, err)
    pushToast({
      kind: 'error',
      title: `${gesture} failed`,
      body: getErrorMessage(err, `Unknown ${gesture.toLowerCase()} error`),
    })
  }
}
