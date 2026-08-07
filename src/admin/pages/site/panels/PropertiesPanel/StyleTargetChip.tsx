/**
 * StyleTargetChip — Track F1's per-selection write-target menu.
 *
 * WS-6.2 shipped this as an exclusive TOGGLE: picking "Element" or "Class"
 * was mutually exclusive with the other (`StyleSurface`'s old `styleTarget`
 * single-value state, backed by the store's `activeClassId`/
 * `inlineStyleEditing` coupling). Track F1 / S6 removed that coupling
 * (`uiStateActions.ts`) — Studio now shows BOTH an element's inline styles
 * AND its class's styles at once, with per-property provenance saying which
 * one wins (`stylePropertyProvenance.ts`). This component's job changed to
 * match: it is no longer "which ONE target is active" but "what does EACH
 * reachable target do, and can I open/close it" — a menu of independent
 * write-target facts, not an exclusive switch.
 *
 * Two structural targets a CSS declaration can actually be typed into today:
 *
 *   | Target      | Writes to                                          |
 *   |-------------|-----------------------------------------------------|
 *   | **Element** | the node's inline `style={{}}` (`setJsxStyle`)       |
 *   | **Class**   | the class's CSS rule — five honest outcomes, below   |
 *
 * Plus a third, non-editable but honestly-labelled row: assigning/removing
 * an entire class token (Tailwind utility, CSS Modules class, hand-authored
 * class — `ClassPicker`, above this chip) is a DIFFERENT kind of edit from
 * setting one declaration's value inside a class already on the node. Track
 * B2 (`setJsxClassName`) made that assignment a real disk write this
 * session; this chip says so, and points at where it actually happens,
 * rather than pretending a single CSS property row can "become" a Tailwind
 * class (there is no general, honest value → utility-class mapping to do
 * that with — synthesizing one would be exactly the kind of guess this
 * panel exists to refuse).
 *
 * ## The Class target's five outcomes
 *
 * `classCssEditability`, computed by the caller from
 * `getStudioStyleRuleSources()` + `classifyStylesheetEditability` (Track B1)
 * + `resolveCssInsertDestination` (Track B1/B1b):
 *
 *   - `{ kind: 'plain-css', file }` — the class already has a real
 *     hand-editable `.css` source. Edits write there now (`setDeclaration`).
 *   - `{ kind: 'will-create-existing', file }` — no source yet, but this
 *     project has exactly one other hand-editable stylesheet Studio already
 *     knows about. The FIRST edit creates the rule there (`insertRule`,
 *     Track B1); every edit after that takes the ordinary `plain-css` path.
 *   - `{ kind: 'will-create-new-stylesheet', pageFile }` — no editable
 *     stylesheet exists in the project yet, but this class is scoped to a
 *     specific element on a known page. The first edit creates a NEW,
 *     co-located stylesheet and wires its `import` into `pageFile` (Track
 *     B1b, server-side — the client can't safely rewrite an import).
 *   - `{ kind: 'compiled', reason }` — a build artefact/CSS-Modules compile;
 *     there is no honest hand-editable source at this layer. `reason` names
 *     the specific cause (`classifyStylesheetEditability`).
 *   - `{ kind: 'unmapped', reason? }` — no source, and no insert destination
 *     could be resolved honestly either (ambiguous candidates, or an
 *     imported/generated rule that was never a candidate to begin with).
 *     `reason`, when present, names why (e.g. which candidate files were
 *     ambiguous).
 *
 * `undefined` (no class assigned yet) falls back to the same "no class"
 * wording the pre-F1 chip used.
 */
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import styles from './StyleTargetChip.module.css'

/** See this module's doc for what each of the five outcomes means and writes. */
export type ClassCssEditability =
  | { kind: 'plain-css'; file: string }
  | { kind: 'will-create-existing'; file: string }
  | { kind: 'will-create-new-stylesheet'; pageFile: string }
  | { kind: 'compiled'; reason: string }
  | { kind: 'unmapped'; reason?: string }

interface StyleTargetChipProps {
  /** Whether the inline "Element" section is currently expanded in the panel. */
  elementVisible: boolean
  /** Present (and clickable, to toggle `elementVisible`) only when the Element target is reachable at all for this node. */
  onToggleElement?: () => void
  /** Why Element can't be reached, shown in the tooltip when `onToggleElement` is omitted. */
  elementDisabledReason?: string
  /** The active class's selector (e.g. `.card`), or undefined when no class is assigned. */
  classSelector?: string
  /** See module doc — only read when `classSelector` is present. */
  classCssEditability?: ClassCssEditability
  disabled?: boolean
}

/** The basename of a workspace-relative path — `src/screens/Home.css` -> `Home.css`. */
function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** True for the two outcomes where an edit genuinely reaches disk (now, or on its first edit). */
function classWrites(editability: ClassCssEditability | undefined): boolean {
  return (
    editability?.kind === 'plain-css' ||
    editability?.kind === 'will-create-existing' ||
    editability?.kind === 'will-create-new-stylesheet'
  )
}

function classTooltip(classSelector: string | undefined, editability: ClassCssEditability | undefined): string {
  if (!classSelector) {
    return 'No class assigned yet — pick or create one in the class picker above.'
  }
  if (!editability || editability.kind === 'unmapped') {
    const reason = editability?.kind === 'unmapped' ? editability.reason : undefined
    return reason
      ? `${reason} Style the element instead for changes that save to disk.`
      : 'This class has no hand-editable CSS source in this project (a generated utility class, a CSS Modules compile, or not yet mapped) — style the element instead for changes that save to disk.'
  }
  if (editability.kind === 'compiled') {
    return `${editability.reason} Style the element instead for changes that save to disk.`
  }
  if (editability.kind === 'plain-css') {
    return `Saved to ${basename(editability.file)} — edits to this class write back to source.`
  }
  if (editability.kind === 'will-create-existing') {
    return `No declarations here yet — the first edit creates this rule in ${basename(editability.file)}.`
  }
  return `No editable stylesheet exists yet — the first edit creates one next to ${basename(editability.pageFile)} and wires its import.`
}

const CLASS_ASSIGNMENT_TOOLTIP =
  'Adding or removing a whole class (a Tailwind utility, a hand-authored class, …) is a different edit from setting one declaration inside a class already here — use the class picker above. Class-token changes now save to source.'

export function StyleTargetChip({
  elementVisible,
  onToggleElement,
  elementDisabledReason,
  classSelector,
  classCssEditability,
  disabled = false,
}: StyleTargetChipProps) {
  const classWritable = classWrites(classCssEditability)

  return (
    <div className={styles.row} data-testid="style-target-chip">
      <span className={styles.editingLabel}>Editing</span>
      <div className={styles.chips} role="group" aria-label="Style edit targets">
        <Button
          variant="secondary"
          size="xs"
          pressed={elementVisible}
          disabled={disabled || !onToggleElement}
          onClick={onToggleElement}
          className={styles.chip}
          data-testid="style-target-chip-element"
          tooltip={
            onToggleElement
              ? elementVisible
                ? 'Writes to this element’s own style="" attribute — click to hide'
                : 'Style this element directly — writes to style=""'
              : (elementDisabledReason ?? 'Remove the assigned class to style this element directly')
          }
        >
          Element
        </Button>
        {/*
          Presentational, not a Button: there is currently no click action
          for the class chip (switching TO a class means picking one in
          ClassPicker, a different surface) — a focusable button with no
          `onClick` is a dead tab stop and a real a11y bug, not a "just in
          case" affordance. `Tooltip` still surfaces the write-back outcome
          on hover without adding one.
        */}
        <Tooltip content={classTooltip(classSelector, classCssEditability)} disabled={disabled}>
          <span
            data-active={classSelector ? 'true' : 'false'}
            data-writable={classWritable ? 'true' : 'false'}
            className={cn(styles.chip, styles.chipStatic, disabled && styles.chipDisabled)}
            data-testid="style-target-chip-class"
          >
            {classSelector ?? 'No class'}
            {classSelector && !classWritable && (
              <WarningDiamondSolidIcon size={11} aria-hidden="true" className={styles.warningIcon} />
            )}
          </span>
        </Tooltip>
        {/* Track B2 — class TOKEN assignment (Tailwind / hand-authored) is a
            structurally different edit from a declaration inside a class
            already assigned; see module doc for why this is informational,
            never a value-editing target. */}
        <Tooltip content={CLASS_ASSIGNMENT_TOOLTIP} disabled={disabled}>
          <span
            className={cn(styles.chip, styles.chipStatic, styles.chipInfo, disabled && styles.chipDisabled)}
            data-testid="style-target-chip-assign"
          >
            Assign class
          </span>
        </Tooltip>
      </div>
    </div>
  )
}
