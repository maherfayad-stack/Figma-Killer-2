/**
 * ConstraintNotice — renders an `EditConstraint` whole: the engine's sentence,
 * where in the user's source it traces to, and its ways forward as real
 * controls.
 *
 * Studio's refusal ENGINE has been right for a while and its UI has not: every
 * `EditConstraint` already carries `origin` (`rel:line:col`) and `actions`
 * (`{label, kind, target?}`), and until this component existed nothing in
 * `src/` rendered either one — a refusal reached the user as an explanation
 * string and nothing else, so "Detach or edit the component definition" was a
 * sentence the user had to act on by hand and `Header.tsx:42` was a fact they
 * had to go find. This is the shared renderer that closes that gap; the
 * kind → handler table it dispatches through is
 * `@site/store/constraintActions` (it sits beside the store because the
 * refusal toast, fired from inside a store action, reaches the same table —
 * see that module's own doc).
 *
 * Honesty rules this component keeps:
 *   - **The engine's copy is rendered, never rewritten.** `explanation` and
 *     each action `label` are printed as authored. This file contributes no
 *     sentences of its own beyond the "Open <file>:<line>" affordance.
 *   - **An action with no runnable handler renders as plain text, not a
 *     disabled button.** "Drag them one by one" is advice; a greyed-out button
 *     would imply the editor could do it and merely won't.
 *   - **An empty `actions` array renders nothing extra.** Per the engine's own
 *     doc, some refusals genuinely have no way forward yet, and inventing one
 *     is worse than admitting it.
 *
 * Warning tone here is STATE, not decoration (`docs/design.md`'s two-layer
 * colour model): the user is blocked and needs to weigh what to do next.
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import type { EditConstraint } from '@core/page-tree'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import { constraintOriginLabel, resolveConstraintAction } from '@site/store/constraintActions'
import styles from './ConstraintNotice.module.css'

interface ConstraintNoticeProps {
  constraint: EditConstraint
  /**
   * The node the refusal is about. Required for the `detach` / `extract`
   * actions, which act on one call site — see `resolveConstraintAction`.
   */
  nodeId?: string
  /**
   * Tighter type and padding, for a host that is already a small surface (the
   * layers context menu's footer). Same content either way.
   */
  compact?: boolean
  className?: string
}

export function ConstraintNotice({ constraint, nodeId, compact, className }: ConstraintNoticeProps) {
  // The origin is offered on its own only when no action already points at a
  // file — otherwise "Open the array in code" and "Open Home.tsx:42" would be
  // two buttons doing the same jump.
  const origin = constraint.actions.some((a) => a.target) ? undefined : constraint.origin

  return (
    <div
      className={cn(styles.notice, compact && styles.compact, className)}
      role="note"
      data-testid="constraint-notice"
      data-constraint-reason={constraint.reason}
      data-constraint-scope={constraint.scope}
    >
      <WarningDiamondSolidIcon size={13} className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.explanation}>{constraint.explanation}</p>
        {(origin || constraint.actions.length > 0) && (
          <div className={styles.actions}>
            {origin && (
              <Button
                variant="ghost"
                size="micro"
                className={styles.action}
                data-testid="constraint-origin"
                onClick={() => jumpToSource(origin)}
              >
                <span>Open {constraintOriginLabel(origin)}</span>
                <ExternalLinkSolidIcon size={10} aria-hidden="true" />
              </Button>
            )}
            {constraint.actions.map((action) => {
              const run = resolveConstraintAction(action, { nodeId, openSource: jumpToSource })
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
          </div>
        )}
      </div>
    </div>
  )
}
