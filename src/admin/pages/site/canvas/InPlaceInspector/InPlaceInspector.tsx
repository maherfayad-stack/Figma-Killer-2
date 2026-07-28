/**
 * InPlaceInspector — compact floating panel of schema-driven property
 * controls for the currently-selected design-system (`alm.*`) component,
 * rendered directly on the canvas so studio users can edit props without
 * opening the docked Properties panel.
 *
 * Reuses the exact same per-prop control the docked panel uses
 * (`PropertyControlRenderer`) against the same module registry schema, so
 * behaviour never drifts between the two surfaces. Prop edits commit through
 * `updateNodeProps` — the same site-slice action the docked panel calls —
 * which mutates the in-memory tree (instant canvas re-render) and lets studio
 * autosave persist it to source on idle.
 *
 * This component owns none of its own positioning — it is a plain block that
 * `BreakpointSelectionOverlay` places inside a positioned portal wrapper (see
 * `positionInspector` in `canvasSelectionOverlayPositioning.ts`). It also owns
 * none of the studio/single-select gating — the overlay only mounts it when
 * that gate passes. It DOES own the "is this an inspectable node" check: bail
 * to null when the node is missing or isn't a design-system component.
 */
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/store'
import type { BaseNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { propLockReason } from '@site/panels/PropertiesPanel/renderModuleTabContent'
import { visibleInspectorControls } from './visibleInspectorControls'
import styles from './InPlaceInspector.module.css'

interface InPlaceInspectorProps {
  nodeId: string
}

/**
 * Resolve a node by id across every page and (when active) the open Visual
 * Component tree. Studio's board mode renders several pages simultaneously —
 * unlike `selectSelectedNode`, which only looks at the single active
 * document — so this searches the whole site rather than assuming the
 * selected node lives on the active page.
 */
function findNodeById(state: EditorStore, nodeId: string): BaseNode | null {
  if (!state.site) return null
  for (const page of state.site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }
  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = state.site.visualComponents?.find((v) => v.id === activeDocument.vcId)
    const node = vc?.tree.nodes[nodeId]
    if (node) return node
  }
  return null
}

export function InPlaceInspector({ nodeId }: InPlaceInspectorProps) {
  const node = useEditorStore((s) => findNodeById(s, nodeId))

  if (!node || !node.moduleId.startsWith('alm.')) return null

  const definition = registry.get(node.moduleId)
  if (!definition) return null

  const props = node.props as Record<string, unknown>
  const controls = visibleInspectorControls(definition.schema, props)

  const handleChange = (key: string, value: unknown) => {
    useEditorStore.getState().updateNodeProps(nodeId, { [key]: value })
  }

  return (
    <div className={styles.panel} data-testid="in-place-inspector">
      <div className={styles.header}>{definition.name}</div>
      <div className={styles.body}>
        {controls.map(([key, control]) => (
          <PropertyControlRenderer
            key={key}
            propKey={key}
            control={control}
            value={props[key]}
            onChange={handleChange}
            // Same per-prop rule the docked panel and the store use. Without it
            // this panel rendered an ordinary, focusable, live-looking input for
            // a prop `updateNodeProps` was going to silently refuse — which is
            // the whole reported bug: type into `title`, watch nothing happen,
            // with nothing on screen saying why.
            sourceLockReason={propLockReason(node, key)}
          />
        ))}
      </div>
    </div>
  )
}
