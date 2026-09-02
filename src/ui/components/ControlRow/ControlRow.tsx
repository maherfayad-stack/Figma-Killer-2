/**
 * ControlRow — shared layout shell used by every property control row.
 *
 * Owns the wrapper div + label row so individual controls don't have to
 * duplicate the same boilerplate. Honors the `layout` variant:
 *
 *   - `inline` (default): label column + control column. The column width is
 *     `--control-label-w`, which the properties panel narrows to its own
 *     `--inspector-label-w`.
 *   - `stacked`: label on its own line above a full-width control.
 *   - `caption`: like `stacked`, but the label is drawn as a Figma-style
 *     group caption — small, subdued, tight to the control it names. This is
 *     the inspector's default for anything that keeps a word label.
 *   - `bare`: no label element at all. For fields whose meaning is carried by
 *     a glyph *inside* the control (`Input`'s `prefix`) or by an enclosing
 *     caption. The caller MUST still give the control an `aria-label` —
 *     `bare` removes the visible label, not the accessible one.
 *
 * The `labelSuffix` slot is used by controls that surface inline metadata
 * next to the label (e.g. NumberControl's unit, MediaLibraryControl /
 * UrlControl's validation error).
 *
 * Shared admin primitive — used by the site editor's PropertiesPanel
 * property controls and the data admin's TableSettings inspector.
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './ControlRow.module.css'

/**
 * Row layout variant.
 *
 * A superset of the module engine's `PropertyControlLayout` (`inline` |
 * `stacked`), which is the persisted schema a module author writes. `caption`
 * and `bare` are presentation choices the inspector makes at render time —
 * they are not something a module declares about its own property, so they
 * deliberately do not widen the schema.
 */
export type ControlRowLayout = 'inline' | 'stacked' | 'caption' | 'bare'

const LAYOUT_CLASS: Record<ControlRowLayout, string | undefined> = {
  inline: undefined,
  stacked: styles.controlWrapperStacked,
  caption: styles.controlWrapperCaption,
  bare: styles.controlWrapperNoLabel,
}

interface ControlRowProps {
  /** Property key — used for the `htmlFor`/`id` linkage when `inputId` is omitted. */
  propKey: string
  /** Visible label text. Falls back to `propKey` when omitted. */
  label?: string
  /** Override the input id used for the `htmlFor` attribute. */
  inputId?: string
  /** Render the row in inline (default), stacked, caption, or bare layout. */
  layout?: ControlRowLayout
  /** Highlight the label as a breakpoint override. */
  isOverride?: boolean
  /** Dim the row to indicate the control is disabled. */
  disabled?: boolean
  /** Optional inline content rendered after the label (unit, validation error). */
  labelSuffix?: ReactNode
  /** Optional caption shown below the row in subdued text. */
  description?: ReactNode
  /** The actual control input(s). */
  children: ReactNode
}

export function ControlRow({
  propKey,
  label,
  inputId,
  layout = 'inline',
  isOverride,
  disabled,
  labelSuffix,
  description,
  children,
}: ControlRowProps) {
  // Allow callers to fully suppress the label row by passing `label=""`
  // (empty string). Useful when a control is embedded inside another
  // labelled control (e.g. BackgroundImageControl mounting MediaLibraryControl
  // inside its `image` mode) and a second label would just add a dead row
  // beneath the outer label. Passing `undefined` keeps the legacy fallback
  // of using `propKey` as the visible label.
  const showLabelRow = layout !== 'bare' && label !== ''

  return (
    <div
      className={cn(
        styles.controlWrapper,
        LAYOUT_CLASS[layout],
        !showLabelRow && styles.controlWrapperNoLabel,
        disabled && styles.controlWrapperDisabled,
      )}
    >
      {showLabelRow && (
        <div className={styles.labelRow}>
          <label
            htmlFor={inputId ?? `ctrl-${propKey}`}
            className={isOverride ? styles.labelOverride : undefined}
          >
            {label ?? propKey}
          </label>
          {labelSuffix}
        </div>
      )}
      {children}
      {description && (
        <span className={styles.description}>{description}</span>
      )}
    </div>
  )
}
