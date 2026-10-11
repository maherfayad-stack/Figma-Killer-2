/**
 * ConstraintActionButtons — the one place an `EditConstraint`'s `.actions`
 * array becomes real controls, extracted out of `ConstraintNotice` (R3,
 * `STUDIO-LIVE-CANVAS-PLAN.md` Track R) so every inspector-resident refusal
 * surface — the layers-context-menu footer (`ConstraintNotice`), the
 * Properties panel's structural lock banner (`SourceConstraintNotice`), and
 * the per-field lock popover (`CodeValueControl`) — renders the SAME buttons
 * instead of three near-identical `.map`s that could quietly drift apart.
 *
 * Each action becomes a runnable `Button` via `resolveConstraintAction`
 * (`@site/store/constraintActions`, the one dispatch table an
 * `EditConstraintAction.kind` goes through), or plain advice text when no
 * handler exists for it — see `ConstraintNotice`'s own doc comment for why an
 * unrunnable action must render as text, never a disabled-looking button.
 *
 * Renders nothing when `constraint.actions` is empty — an empty array is a
 * deliberate, honest terminal refusal (the engine's own doc), not a gap this
 * component should paper over with an invented affordance.
 */
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { layoutFileOf, layoutRouteCount, type EditConstraint, type EditConstraintAction } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import { resolveConstraintAction } from '@site/store/constraintActions'
import { useEditorStore } from '@site/store/store'
import styles from './ConstraintActionButtons.module.css'

/**
 * K6's `position-parent-relative` remedy, supplied here rather than inside
 * `constraintActions.ts` for the same reason `openSource` is: that module sits
 * inside the store's own import graph and may not import the composed store
 * back. One inline declaration on the container, through the ordinary
 * inline-style write path — so it lands in the user's `style={{…}}` like any
 * other inspector edit, and ⌘Z undoes it.
 */
function makeParentRelative(nodeId: string): void {
  useEditorStore.getState().setNodeInlineStyles(nodeId, { position: 'relative' })
}

/** P5-C — the one Detach action, injected for `makeParentRelative`'s reason. */
function detachInstances(nodeIds: readonly string[]) {
  return useEditorStore.getState().detachInstances(nodeIds)
}

/** G-8 — start "Edit layout" for the layout file `nodeId` is written in, when no refused gesture is waiting to be replayed. */
function startLayoutEdit(nodeId: string): void {
  const rel = layoutFileOf(nodeId)
  if (rel) useEditorStore.getState().setMainEditTarget({ kind: 'layout', rel })
}

/** G-9 — write out the list `nodeId` belongs to, when no refused gesture is waiting to be replayed. */
function unrollListOf(nodeId: string): void {
  void useEditorStore.getState().unrollList(nodeId)
}

/**
 * The label of an action, with the blast radius spelled out where it has one:
 * "Edit layout (12 routes)" — the user is choosing to change a file that many
 * frames render.
 */
function useActionLabel(action: EditConstraintAction, nodeId: string | undefined): string {
  const routes = useEditorStore((state) => {
    const rel = action.kind === 'edit-layout' && nodeId !== undefined ? layoutFileOf(nodeId) : null
    return rel !== null && state.site ? layoutRouteCount(state.site.pages, rel) : 0
  })
  return routes > 1 ? `${action.label} (${routes} routes)` : action.label
}

interface ConstraintActionButtonsProps {
  constraint: EditConstraint
  /**
   * The node the refusal is about. Required for the `detach` / `extract`
   * actions, which act on one call site — see `resolveConstraintAction`.
   */
  nodeId?: string
  /**
   * Fired when a `detach`/`extract` button's async codemod settles — see
   * `ConstraintActionContext.onSettled`. `RefusalDialog` (R2, `store-10`) is
   * the only caller that supplies this today; every existing caller omits it
   * and renders exactly as before.
   */
  onActionSettled?: (action: EditConstraintAction, ok: boolean) => void
  /**
   * D2 G3 — the `duplicate-into-frame` remedy's handler. Supplied only by
   * `RefusalDialog`, which is the one surface that has it (it arrives on the
   * dialog's own state, closed over by the store action that refused — there
   * is no node id this component could rebuild it from). Every other caller
   * omits it, so the action renders as advice text there rather than a button
   * that could not work.
   */
  duplicateIntoFrame?: () => void
  /**
   * G-9 / G-8 — remedies that end with the refused gesture running again.
   * Supplied only by `RefusalDialog` (they close over the gesture); any other
   * surface gets the plain version — the list written out, the mode started —
   * with nothing to replay.
   */
  replayRemedies?: { unrollList?: () => void; editLayout?: () => void }
}

export function ConstraintActionButtons({ constraint, nodeId, onActionSettled, duplicateIntoFrame, replayRemedies }: ConstraintActionButtonsProps) {
  if (constraint.actions.length === 0) return null

  return (
    <>
      {constraint.actions.map((action) => (
        <ConstraintActionControl
          key={action.kind + action.label}
          action={action}
          nodeId={nodeId}
          onActionSettled={onActionSettled}
          duplicateIntoFrame={duplicateIntoFrame}
          replayRemedies={replayRemedies}
        />
      ))}
    </>
  )
}

function ConstraintActionControl({
  action,
  nodeId,
  onActionSettled,
  duplicateIntoFrame,
  replayRemedies,
}: Omit<ConstraintActionButtonsProps, 'constraint'> & { action: EditConstraintAction }) {
  const label = useActionLabel(action, nodeId)
  const unrollList = replayRemedies?.unrollList ?? (nodeId === undefined ? undefined : () => unrollListOf(nodeId))
  const editLayout = replayRemedies?.editLayout ?? (nodeId === undefined ? undefined : () => startLayoutEdit(nodeId))
  const run = resolveConstraintAction(action, {
    nodeId,
    openSource: jumpToSource,
    makeParentRelative,
    detachInstances,
    ...(duplicateIntoFrame ? { duplicateIntoFrame } : {}),
    ...(unrollList ? { unrollList } : {}),
    ...(editLayout ? { editLayout } : {}),
    ...(onActionSettled ? { onSettled: (ok: boolean) => onActionSettled(action, ok) } : {}),
  })
  return run ? (
    <Button variant="ghost" size="micro" className={styles.action} data-testid={`constraint-action-${action.kind}`} onClick={run}>
      <span>{label}</span>
      {action.target && <ExternalLinkSolidIcon size={10} aria-hidden="true" />}
    </Button>
  ) : (
    <span className={styles.hint} data-testid={`constraint-hint-${action.kind}`}>
      {action.label}
    </span>
  )
}
