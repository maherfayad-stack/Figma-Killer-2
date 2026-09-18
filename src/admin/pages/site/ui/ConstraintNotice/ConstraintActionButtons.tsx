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
import type { EditConstraint, EditConstraintAction } from '@core/page-tree'
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
}

export function ConstraintActionButtons({ constraint, nodeId, onActionSettled, duplicateIntoFrame }: ConstraintActionButtonsProps) {
  if (constraint.actions.length === 0) return null

  return (
    <>
      {constraint.actions.map((action) => {
        const run = resolveConstraintAction(action, {
          nodeId,
          openSource: jumpToSource,
          makeParentRelative,
          ...(duplicateIntoFrame ? { duplicateIntoFrame } : {}),
          ...(onActionSettled ? { onSettled: (ok: boolean) => onActionSettled(action, ok) } : {}),
        })
        return run ? (
          <Button
            key={action.kind + action.label}
            variant="ghost"
            size="micro"
            className={styles.action}
            data-testid={`constraint-action-${action.kind}`}
            onClick={run}
          >
            <span>{action.label}</span>
            {action.target && <ExternalLinkSolidIcon size={10} aria-hidden="true" />}
          </Button>
        ) : (
          <span
            key={action.kind + action.label}
            className={styles.hint}
            data-testid={`constraint-hint-${action.kind}`}
          >
            {action.label}
          </span>
        )
      })}
    </>
  )
}
