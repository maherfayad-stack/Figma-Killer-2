/**
 * SourceConstraintNotice — the ONE whole-node structural fact worth a banner,
 * plus (unrelated but sharing this slot) the one whole-node fact about where
 * a resolved TEXT literally lives.
 *
 * Track F2 / R7 (`docs/audits/2026-08-06/09-refusal-states.md`) deleted this
 * component's THIRD variant — "nothing structural at all, only values came
 * from code" — which used to render unconditionally on the MAJORITY of a
 * real imported board's nodes (149/276 on the eSIM corpus) to say something
 * `CodeValueControl` already says, per field, right next to the control it's
 * about (`propLockReason` now names each prop's own resolved source — R2).
 * A node-level paragraph repeating that fact was noise, not new information.
 *
 * What's left is exactly two honest, whole-node things:
 *
 * 1. **Structural** — the source does not PLACE this element (a ternary/`&&`
 *    chose it, a spread feeds it, a `.map` renders every row). `lockReason`
 *    is present only for this case, and is what selects it.
 * 2. **Resolved text has a known literal home** (`textOrigin`) — genuinely
 *    node-level (not a per-field fact `CodeValueControl` could show, because
 *    a node with `textOrigin` is WRITABLE: no disabled row exists to attach
 *    a per-field hint to; the control is an ordinary editable text input).
 *    Independent of the structural lock — either, both, or neither may be
 *    true of a given node.
 *
 * R8: `textOrigin`'s `file:line` is now a real jump-to-source button, not
 * plain text (`jumpToSource.ts`).
 *
 * R3 (`STUDIO-LIVE-CANVAS-PLAN.md` Track R): the structural half used to stop
 * at the sentence — "this element can't be moved or deleted", full stop, no
 * way forward. `constraint` (computed by the caller via `refusePlacement` +
 * `describeStructuralRefusal`, the SAME two calls `explainPropConstraint`'s
 * own `list-row` branch makes internally, so the two can never disagree about
 * which reason a given node has) carries real `actions` — "Detach this
 * instance", "Open the component definition" — rendered below the bespoke
 * prose via `ConstraintActionButtons`, the identical renderer
 * `LayerNodeContextMenu`'s refusal footer already uses. The prose itself
 * stays hand-written rather than switching to `ConstraintNotice`'s generic
 * wrapper: it carries a nuance (structurally locked but "its own values are
 * editable") that `EditConstraint.explanation` alone doesn't.
 *
 * ## `writeTargetReason` — a THIRD, independent fact (`STATE.md` panel-30)
 *
 * `resolveWriteTarget`'s `{ kind: 'none', reason }` is a genuinely different
 * claim from `lockReason`: it says nothing about the NODE's structure (the
 * node itself is ordinarily movable, deletable, whatever) — it says one
 * PROPERTY, right now, has no honest place for a NEW declaration to land (no
 * writable class, inline locked). Reusing the structural prose's hardcoded
 * "can't be moved or deleted" sentence for this fact would be actively
 * wrong, so it gets its own short paragraph instead — same visual treatment
 * (the warning-tone `.notice`, `LockSolidIcon`, "say so, don't hide it"),
 * different words. Mutually exclusive with `lockReason`/`textOrigin` in
 * practice (a Fill popover's muted row either has a write-target refusal or
 * it doesn't), so no case renders more than one of the three at once.
 *
 * ## `writeTargetNote` — a FOURTH, informational fact (`STATE.md` panel-32)
 *
 * Not a refusal — a value the panel prefills from somewhere OTHER than the
 * active editing context (a class declaration at BASE, shown muted while a
 * breakpoint/condition override tab is active — `renderedNotStored.ts`'s
 * widened contract). Editing that field does not touch the declaration being
 * shown; it writes a NEW one at the active context, via the exact same
 * `resolveWriteTarget`/`commitApi.ts` path every other field already uses
 * (`commitApi.ts`'s `writeToTarget`: a `class` target always lands on
 * `setClassContextStyles` when a context is active, never on the base
 * declaration). Saying so here — instead of a silent prefill that could read
 * as "you are editing this" — is what closes the "must not lie about what
 * editing does" gap: a muted row is real information, not an invitation to
 * mistake it for the row it is about to replace. Informational styling
 * (`.noticeInfo`, `CodeIcon`), same as `textOrigin`-only — never rendered
 * alongside `writeTargetReason` (a write-target FACT is either a refusal or a
 * note, never both for the same field).
 */
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import type { EditConstraint } from '@core/page-tree'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { ConstraintActionButtons } from '@site/ui/ConstraintNotice'
import { jumpToSource } from './jumpToSource'
import styles from './SharedComponentNotice.module.css'

interface SourceConstraintNoticeProps {
  /**
   * `PageNode.lockReason` — the parser's own human-readable phrase for a
   * STRUCTURAL lock. Absent when the element's structure is ordinary source.
   */
  lockReason?: string
  /**
   * `PageNode.textOrigin` — where the text's string literal lives, when it has
   * one. Its presence means an edit to the text lands there instead of on the
   * JSX, so the notice can say where the user's typing will go.
   */
  textOrigin?: { rel: string; line: number; col: number }
  /** How many nodes across the site resolve their text to the SAME literal. */
  sharedWith?: number
  /**
   * False for a `.map` row: one piece of source JSX renders every row, so no
   * prop write here could land on this row alone.
   */
  hasWritableLocation: boolean
  /**
   * The structural refusal, dressed as an `EditConstraint` by the caller —
   * `null`/`undefined` when `lockReason` is absent (there is nothing to
   * dress). Supplies the real remedy buttons below the bespoke prose; see
   * this file's own doc comment for why the prose stays hand-written.
   */
  constraint?: EditConstraint | null
  /** The locked node's id — `detach`/`extract` act on this one call site. */
  nodeId?: string
  /**
   * `resolveWriteTarget`'s `{ kind: 'none' }.reason` — a single PROPERTY has
   * no honest target for a new declaration. See this file's own doc comment
   * for why this is independent of `lockReason` and gets its own prose
   * rather than reusing the structural sentence.
   */
  writeTargetReason?: string
  /**
   * A non-refusal fact about where a write WOULD land — see this file's own
   * `writeTargetNote` doc section. Mutually exclusive with `writeTargetReason`
   * in practice (a field either has an honest target or it doesn't).
   */
  writeTargetNote?: string
}

export function SourceConstraintNotice({
  lockReason,
  textOrigin,
  sharedWith,
  hasWritableLocation,
  constraint,
  nodeId,
  writeTargetReason,
  writeTargetNote,
}: SourceConstraintNoticeProps) {
  const structural = lockReason !== undefined
  const writeRefused = !structural && textOrigin === undefined && writeTargetReason !== undefined
  const noteOnly = !structural && !writeRefused && textOrigin === undefined && writeTargetNote !== undefined

  // None of the four facts applies — say nothing. `CodeValueControl` (per
  // prop) and `InlineStyleComposer` (per style property, once F1's
  // provenance wiring lands — see `editConstraint.ts`'s
  // `explainStyleConstraint` doc) carry every other fact this component used
  // to repeat.
  if (
    !structural &&
    textOrigin === undefined &&
    writeTargetReason === undefined &&
    writeTargetNote === undefined
  ) {
    return null
  }

  return (
    <div
      className={cn(styles.notice, !structural && !writeRefused ? styles.noticeInfo : undefined)}
      role="note"
      data-testid="source-constraint-notice"
      data-variant={
        structural
          ? hasWritableLocation
            ? 'structure-locked'
            : 'list-row'
          : writeRefused
            ? 'write-target-refused'
            : textOrigin !== undefined
              ? 'text-origin-only'
              : 'write-target-note'
      }
    >
      {structural || writeRefused ? (
        <LockSolidIcon size={14} className={styles.icon} />
      ) : (
        <CodeIcon size={14} className={styles.icon} />
      )}
      <div className={styles.body}>
        <p className={styles.text}>
          {structural ? (
            <>
              <strong>{lockReason}</strong>.{' '}
              {hasWritableLocation ? (
                <>
                  This element can&apos;t be moved or deleted from here, but its own values are
                  editable and write straight to the source.
                </>
              ) : (
                <>
                  One piece of source renders every row of this list, so a style or class change here
                  is written to that source and applies to all of them. Its other values stay
                  read-only.
                </>
              )}
            </>
          ) : null}
          {writeRefused ? writeTargetReason : null}
          {noteOnly ? writeTargetNote : null}
          {textOrigin ? (
            <>
              {' '}Its text comes from{' '}
              <Button
                variant="ghost"
                size="xs"
                className={styles.jumpToSourceButton}
                onClick={() => jumpToSource(textOrigin)}
              >
                {textOrigin.rel} (line {textOrigin.line})
                <ExternalLinkSolidIcon size={11} />
              </Button>
              ; editing it writes there
              {sharedWith !== undefined && sharedWith > 1 ? (
                <> and changes all <strong>{sharedWith}</strong> places that use it</>
              ) : null}
              .
            </>
          ) : null}
        </p>
        {structural && constraint && constraint.actions.length > 0 ? (
          <div className={styles.actions}>
            <ConstraintActionButtons constraint={constraint} nodeId={nodeId} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
