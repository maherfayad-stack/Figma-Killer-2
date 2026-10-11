/**
 * The Vector section's manifest predicate, apart from the section itself so
 * the manifest (`sections/index.ts`, in the editor body) does not pull the
 * lazily-loaded Vector controls and their model forward — the same split as
 * `componentSectionSelection.ts`.
 */
import type { SelectionModel } from '../selectionModel'

/** One selected node, and it is an inline `<svg>` (`base.svg`). */
export function showsVectorSection(model: SelectionModel): boolean {
  return !model.isMultiSelect && model.selectedNode?.moduleId === 'base.svg'
}
