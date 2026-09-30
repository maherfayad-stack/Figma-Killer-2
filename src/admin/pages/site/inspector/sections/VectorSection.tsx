/**
 * VectorSection — Figma's vector paint for an inline `<svg>`: fill, stroke,
 * weight, caps and joins, opacity, and the graphic's own width / height /
 * viewBox. Mounted for exactly one selected `base.svg`.
 *
 * Why it exists beside Fill and Stroke: those two edit CSS (`background`,
 * `border`), which is what a BOX's fill and stroke are. An SVG's fill is its
 * `fill` attribute, inherited down its shapes — CSS `background` on an icon
 * paints the rectangle behind it. Before this section a selected `<svg>`
 * offered only the CSS pair, so "the icon's fill" could not be changed at all
 * (owner report). The attribute writes ride the P5-D `svg-attr` edit kind.
 *
 * The body is `VectorPaintControls`, shared with the loose-layer inspector.
 */
import { Section } from '@ui/components/Section'
import { useSelectionModel } from '../selectionModel'
import { VectorPaintControls } from './VectorPaintControls'
import { showsVectorSection } from './vectorPaintModel'

export function VectorSection() {
  const model = useSelectionModel()
  const { selectedNodeId, selectedNode } = model
  if (!selectedNodeId || !selectedNode || !showsVectorSection(model)) return null
  return (
    <Section title="Vector" forceOpen>
      {/* Keyed by node: a new graphic starts on "Whole graphic" with no burst in flight. */}
      <VectorPaintControls key={selectedNodeId} nodeId={selectedNodeId} node={selectedNode} />
    </Section>
  )
}
