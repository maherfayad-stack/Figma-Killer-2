/**
 * Shared types for property controls.
 *
 * Styles are now in controls.module.css — imported per-component.
 * This file only exports TypeScript interfaces.
 */
import type { PropertyControlLayout } from '@core/module-engine'

/** Props shared by every property control component. */
export interface ControlProps<T = unknown> {
  /** Property key in the node's props map */
  propKey: string
  /** Current value */
  value: T
  /** Fires whenever the value changes — causes an immediate store update */
  onChange: (propKey: string, value: T) => void
  /** Optional label override (falls back to schema label) */
  label?: string
  /** Whether the control is for a breakpoint override (highlights modified props) */
  isOverride?: boolean
  /** Disable the control */
  disabled?: boolean
  /**
   * Row layout — `inline` (default) renders a 100px label column + control,
   * `stacked` renders the label above a full-width control. Resolved by
   * `PropertyControlRenderer` from the schema (with sensible per-type
   * defaults), so individual controls always receive a concrete value.
   */
  layout?: PropertyControlLayout
  /**
   * The id of the node that OWNS this prop — the call site for a
   * `studio.instance`'s `callSiteProps:<key>`, or the node itself for every
   * other module. Only `SlotControl` (E2.5) reads this: filling an empty
   * slot writes an `insert-slot` edit whose `nodeId` targets the CALL SITE,
   * never the slot's own (locked) node — see that control's doc comment.
   * Every other control ignores it.
   */
  ownerNodeId?: string
}
