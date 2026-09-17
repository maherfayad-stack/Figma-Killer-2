/**
 * colorWriteTargetNote — panel-32's informational fact, factored to a single
 * pure function so `FillSection.tsx` doesn't carry the same six-line ternary
 * twice (once for `color`, once for `backgroundColor`). A plain function, not
 * a component, so it lives in its own file rather than beside
 * `FillColorField.tsx` — `react-refresh/only-export-components` forbids
 * mixing the two in one module.
 *
 * A muted row prefilled from somewhere OTHER than the active editing context
 * (a class declaration at BASE, shown while a breakpoint/condition override
 * tab is active) is real information, not an invitation to mistake it for the
 * declaration it's about to replace — see `SourceConstraintNotice`'s own doc
 * for the full "writeTargetNote" rationale this reuses verbatim.
 */
import type { WriteTarget } from '../resolveWriteTarget'

export function colorWriteTargetNote(
  stored: boolean,
  declaredElsewhere: boolean,
  writeTarget: WriteTarget | null,
): string | undefined {
  if (stored || !declaredElsewhere || !writeTarget || writeTarget.kind === 'none') return undefined
  return writeTarget.kind === 'class'
    ? `This colour is declared elsewhere (base, or another view) on ${writeTarget.selector}. Editing here saves a new override for the current view only.`
    : "This colour is declared elsewhere (base, or another view). Editing here saves it on this element's own style, for the current view only."
}
