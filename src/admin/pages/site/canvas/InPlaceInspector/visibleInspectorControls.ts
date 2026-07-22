/**
 * visibleInspectorControls — pure schema-filtering helper shared by the
 * in-place mini-inspector.
 *
 * Mirrors the exact filtering `renderModuleTabContent` applies before handing
 * a schema entry to `PropertyControlRenderer`:
 *   - `hidden` controls carry a declared `type` for engine purposes only
 *     (the publisher's escaping dispatch) and never get an editor surface —
 *     e.g. `base.outlet.html`, a publisher-filled binding target the author
 *     never hand-edits.
 *   - a `condition` gates the control on another prop's current value
 *     (`evaluateCondition`, same helper the docked panel uses).
 *
 * Kept as a standalone pure function (no DOM, no store) so the filtering
 * logic is unit-testable without mounting the canvas or the overlay.
 */
import type { PropertyControl, PropertySchema } from '@core/module-engine'
import { evaluateCondition } from '@core/page-tree'

export function visibleInspectorControls(
  schema: PropertySchema,
  props: Record<string, unknown>,
): Array<[string, PropertyControl]> {
  return Object.entries(schema).filter(([, control]) => {
    if (control.hidden) return false
    if (control.condition && !evaluateCondition(control.condition, props)) return false
    return true
  })
}
