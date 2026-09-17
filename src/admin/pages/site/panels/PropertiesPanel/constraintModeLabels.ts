/**
 * The words the two constraint surfaces put on `constraintMapping.ts`'s five
 * modes. Stated once so the crosshair's tooltip and the dropdown's option
 * text can never drift into naming the same CSS two different things.
 *
 * Per axis, because Figma names them per axis too: `start` is "Left"
 * horizontally and "Top" vertically, and the stretch constraint is "Left and
 * right" / "Top and bottom".
 */
import type { ConstraintAxis, ConstraintMode } from './constraintMapping'

export const CONSTRAINT_MODE_LABELS: Record<ConstraintAxis, Record<ConstraintMode, string>> = {
  x: { start: 'Left', end: 'Right', stretch: 'Left and right', center: 'Centre', scale: 'Scale' },
  y: { start: 'Top', end: 'Bottom', stretch: 'Top and bottom', center: 'Centre', scale: 'Scale' },
}
