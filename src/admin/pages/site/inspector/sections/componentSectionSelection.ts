/**
 * Whether the Component section mounts for a selection — its own file
 * because `react-refresh/only-export-components` forbids a plain function
 * export beside `ComponentSection`.
 *
 * Exactly one selected node, and that node a component instance. Under a
 * multi-selection `SelectionModel.selectedNode` is the ANCHOR, and a section
 * that showed the anchor's call-site values would be lying about the
 * selection — every row, Detach and Swap would edit one instance of N (P2-G,
 * UX-14). The manifest's `appliesTo` and the component's own guard are this
 * one predicate.
 */
import type { SelectionModel } from '../selectionModel'

export function showsComponentSection(selection: SelectionModel): boolean {
  return !selection.isMultiSelect && selection.selectedNode?.moduleId === 'studio.instance'
}
