/**
 * StyleTargetChip — WS-6.2's "the honest version of Figma".
 *
 * Figma edits one object. Here a style change goes to one of two places
 * this panel can currently reach (a third, `.class:state`, is a real gap —
 * see the note below):
 *
 *   | Target              | Writes to                                    |
 *   |---------------------|-----------------------------------------------|
 *   | **Element**         | the node's inline `style={{}}` (`setJsxStyle`) |
 *   | **Class** `.card`   | the CSS rule — see `classCssEditability` below |
 *
 * The chip makes the current target unmissable and states the write-back
 * outcome inline, on the target itself, rather than in a doc a user will
 * never open: hiding the difference is worse than showing it, because a
 * user who loses styling work they thought was saved won't trust the tool
 * again.
 *
 * `panel-02` (WS-6.3) — the Class chip's warning is no longer a blanket
 * "preview-only" for every project. `classCssEditability`, computed by the
 * caller from `getStudioStyleRuleSources()` + `classifyStylesheetEditability`
 * (`@core/css-codemods`), tells this component which of three honest
 * outcomes applies to the CURRENTLY active class:
 *
 *   - `{ kind: 'plain-css', file }`  — real declaration edits reach `file`
 *     on save. No warning icon; the tooltip says where it saves.
 *   - `{ kind: 'compiled', reason }` — a build artefact/CSS-Modules compile
 *     has no honest hand-editable source at this layer. Warning icon stays,
 *     tooltip states the SPECIFIC reason (from `classifyStylesheetEditability`)
 *     and points at the element as the alternative.
 *   - `{ kind: 'unmapped' }`         — no `.css` file this project's load
 *     mapped this rule to (a Tailwind/Sass/PostCSS-generated class, or a
 *     non-`.css` stylesheet) — same honest "style the element instead"
 *     message, generic because there is no specific file/reason to name.
 *
 * `undefined` (target isn't `'class'`, or the caller hasn't computed it yet)
 * falls back to the `unmapped` wording — never claims a save that hasn't
 * happened.
 *
 * Honest scope note (found while building this, not assumed from the plan):
 * this codebase's `StyleRule` selector is either a class (`.card`) or an
 * "ambient" raw CSS selector imported verbatim (which CAN already include a
 * pseudo-class, e.g. `a:hover`, when it came from the user's own CSS) — but
 * there is no first-class "toggle `:hover` on the currently-active class"
 * UI/store action the way `STUDIO-IMPORT-V2-PLAN.md` §6.2's ".card:hover"
 * example implies. `site.conditions` models `@media`/`@container`/
 * `@supports` breakpoints/conditions, not element pseudo-states. So this
 * chip shows the pseudo-state suffix when the ACTIVE class's own selector
 * already carries one (an ambient rule), and does not fabricate a
 * state-picker feature that doesn't exist yet.
 */
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import styles from './StyleTargetChip.module.css'

/**
 * 'none' — no class assigned and not currently inline-editing (the
 * `LockedStylePreview` teaser state). Neither chip reads as "active"; the
 * user hasn't picked a target yet.
 */
export type StyleEditTarget = 'element' | 'class' | 'none'

/** See this module's doc for the three outcomes and what each renders. */
export type ClassCssEditability =
  | { kind: 'plain-css'; file: string }
  | { kind: 'compiled'; reason: string }
  | { kind: 'unmapped' }

interface StyleTargetChipProps {
  target: StyleEditTarget
  /** The active class's selector (e.g. `.card`, or `a:hover` for an ambient rule). Required when `target === 'class'`. */
  classSelector?: string
  /** WS-6.3 — whether the active class's declarations reach disk on save, and why/why not. Only read when `target === 'class'`. */
  classCssEditability?: ClassCssEditability
  /** Present (and clickable) only when switching to Element is currently reachable — see `StyleSurface`'s `showInline` gate. */
  onSelectElement?: () => void
  disabled?: boolean
}

/** The basename of a workspace-relative path — `src/screens/Home.css` -> `Home.css`. */
function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function classTooltip(target: StyleEditTarget, editability: ClassCssEditability | undefined): string {
  if (target !== 'class') return ''
  if (!editability || editability.kind === 'unmapped') {
    return 'This class has no hand-editable CSS source in this project (a generated utility class, a CSS Modules compile, or not yet mapped) — style the element instead for changes that save to disk.'
  }
  if (editability.kind === 'compiled') {
    return `${editability.reason} Style the element instead for changes that save to disk.`
  }
  return `Saved to ${basename(editability.file)} — edits to this class write back to source.`
}

export function StyleTargetChip({ target, classSelector, classCssEditability, onSelectElement, disabled = false }: StyleTargetChipProps) {
  const classWritable = target === 'class' && classCssEditability?.kind === 'plain-css'

  return (
    <div className={styles.row} data-testid="style-target-chip">
      <span className={styles.editingLabel}>Editing</span>
      <div className={styles.chips} role="group" aria-label="Style edit target">
        <Button
          variant="secondary"
          size="xs"
          pressed={target === 'element'}
          disabled={disabled || !onSelectElement}
          onClick={onSelectElement}
          className={styles.chip}
          data-testid="style-target-chip-element"
          tooltip={onSelectElement ? 'Edit this element’s own inline style' : 'Remove the assigned class to style this element directly'}
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
        <Tooltip content={classTooltip(target, classCssEditability)} disabled={disabled || target !== 'class'}>
          <span
            data-active={target === 'class' ? 'true' : 'false'}
            data-writable={classWritable ? 'true' : 'false'}
            className={cn(
              styles.chip,
              styles.chipStatic,
              target === 'class' && styles.chipClass,
              disabled && styles.chipDisabled,
            )}
            data-testid="style-target-chip-class"
          >
            {target === 'class' ? classSelector : 'No class'}
            {target === 'class' && !classWritable && (
              <WarningDiamondSolidIcon size={11} aria-hidden="true" className={styles.warningIcon} />
            )}
          </span>
        </Tooltip>
      </div>
    </div>
  )
}
