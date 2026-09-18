/**
 * writeBackgroundModel — the smallest-diff writer for a `BackgroundModel`
 * edit. Split into its own (non-component) file so `FillSectionActions.tsx`
 * and `FillSection.tsx` can both import it without either file exporting a
 * plain function alongside a component (`react-refresh/only-export-components`,
 * on for all of `src/`).
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { backgroundModelPatch, type BackgroundModel } from '../../panels/PropertiesPanel/backgroundLayers'

/**
 * Writes a new layer model as the SMALLEST set of `onChange` calls that
 * expresses the difference. `onChange` is one store mutation (and one AST
 * writeback) per call, so re-emitting all eight `background-*` properties on
 * every gradient keystroke would put seven no-op writes in the user's undo
 * history.
 */
export function writeBackgroundModel(
  previous: BackgroundModel,
  next: BackgroundModel,
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void,
) {
  const before = backgroundModelPatch(previous)
  const after = backgroundModelPatch(next)
  for (const [property, value] of Object.entries(after)) {
    if (before[property as keyof CSSPropertyBag] === value) continue
    onChange(property as keyof CSSPropertyBag, value)
  }
}
