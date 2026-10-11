/**
 * frameModeOptions - what a board frame's mode chips and "+ Mode" menu offer,
 * from the token catalog's axes and the axes the frame is previewing (CT-4).
 * Pure, so the rules (which axes get a chip, what each chip says, which modes
 * "+ Mode" can add) are tested without a document.
 *
 * A chip exists only for an axis the project's own CSS declares and a frame
 * root can emulate (`axisChoices`): a project with no dark mode gets no
 * Light/Dark chip, never a disabled one.
 */
import { getAxisMode, withAxisMode, type PreviewAxes } from '@core/studio-board'
import { axisChoices, isCatalogDrivenAxis, type ModeAxis, type ModeChoice } from '@core/studio-tokens'

export interface FrameModeChip {
  readonly axisId: string
  readonly axisLabel: string
  readonly choices: readonly ModeChoice[]
  /** The choice the frame is on now. */
  readonly current: ModeChoice
}

export interface FrameModeVariant {
  readonly axisId: string
  /** `Dark`, or `Theme: Compact` when the project has more than one chip axis. */
  readonly label: string
  /** The override the new frame gets: the source's own pins with this one mode changed. */
  readonly axes: Partial<PreviewAxes>
}

export function frameModeChips(modeAxes: readonly ModeAxis[], effective: PreviewAxes): FrameModeChip[] {
  const chips: FrameModeChip[] = []
  for (const axis of modeAxes) {
    if (!isCatalogDrivenAxis(axis.id)) continue
    const choices = axisChoices(axis)
    if (choices.length === 0) continue
    const currentId = getAxisMode(effective, axis.id) ?? null
    const current = choices.find((choice) => choice.id === currentId) ?? choices[0]!
    chips.push({ axisId: axis.id, axisLabel: axis.label, choices, current })
  }
  return chips
}

/** Every mode "+ Mode" can duplicate this frame into: each chip axis' choices except the one the frame is on. */
export function frameModeVariants(chips: readonly FrameModeChip[], pinned: Partial<PreviewAxes> | undefined): FrameModeVariant[] {
  const variants: FrameModeVariant[] = []
  for (const chip of chips) {
    for (const choice of chip.choices) {
      if (choice.id === chip.current.id) continue
      variants.push({
        axisId: chip.axisId,
        label: chips.length > 1 ? `${chip.axisLabel}: ${choice.label}` : choice.label,
        axes: withAxisMode({ ...pinned }, chip.axisId, choice.id ?? undefined),
      })
    }
  }
  return variants
}
