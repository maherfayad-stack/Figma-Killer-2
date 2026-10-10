/**
 * IgnoreAutoLayoutRow (PA-4) — Figma's "Ignore auto layout" for a child of a
 * flex / grid container. On: the layer is `position: absolute` where it
 * already is, and its container is made `relative` in the same undo step when
 * that is one element's to write. Off: it goes back into the flow at its place
 * in the child order. The state is read from the layer's own computed
 * position, so a layer an author already made absolute reads as ignoring.
 *
 * `locked` is the layer's `style:position` being set in code — the switch is
 * then disabled with that as its reason, never a control that does nothing.
 */
import { Switch } from '@ui/components/Switch'
import { setLayerIgnoresAutoLayout } from '@site/canvas/ignoreAutoLayout'
import styles from './IgnoreAutoLayoutRow.module.css'

interface IgnoreAutoLayoutRowProps {
  nodeId: string
  ignoring: boolean
  locked: boolean
}

export function IgnoreAutoLayoutRow({ nodeId, ignoring, locked }: IgnoreAutoLayoutRowProps) {
  return (
    <label
      className={styles.row}
      title={locked ? "This layer's position is set in code, so Studio cannot change it here." : "Place this layer by position instead of by its container's auto layout"}
      data-testid="ignore-auto-layout-row"
    >
      <Switch
        checked={ignoring}
        disabled={locked}
        switchSize="sm"
        aria-label="Ignore auto layout"
        onCheckedChange={(next) => setLayerIgnoresAutoLayout(nodeId, next)}
      />
      <span className={styles.label}>Ignore auto layout</span>
    </label>
  )
}

/**
 * "Free frame" — the layer's container has no auto layout and every child in
 * it is placed by its own offsets (`parentPlacementKind`), so dragging moves
 * a layer rather than reordering it. Derived from the live frame, never
 * written to the source (OD-P1/OD-P5: no fifth "Free" layout mode).
 */
export function FreeFrameChip() {
  return (
    <span
      className={styles.freeFrameChip}
      title="Every layer in this frame is placed by its own position — dragging moves, it does not reorder"
      data-testid="free-frame-chip"
    >
      Free frame
    </span>
  )
}
