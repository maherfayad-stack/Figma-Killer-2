/**
 * studioCanvasLayerScope — WHO may write a loose layer (P5-G, FC-1 decision).
 *
 * The editor's own `/save` passes `canvasLayers: 'allow'`. Every other batch —
 * an agent's `studio_apply_edits` — refuses, by name (`canvas-layer-agent`),
 * every `canvas-layer-*` kind AND any edit whose target, anchor, destination
 * or group sibling decodes into a layer module. Default deny: a new caller of
 * `applyStudioEditBatch` gets the refusal unless it opts in. The agent's native
 * file tools were already refused all of `.studio/` (`agentWriteScope.ts`);
 * loose layers are the human's scratch space, and the agent gets narrow tools
 * for them in FC-8 rather than a side door here.
 *
 * Its own module so `studioCanvasLayerWriteback.ts` never imports the refusal
 * and schema modules back (they fold its kinds in).
 */
import { canvasLayerIdFromRel, isCanvasLayerEditNodeId } from '@core/studio-board'
import { isCanvasLayerEditKind } from './studioCanvasLayerWriteback'
import { refusalFor } from './studioEditRefusals'
import type { StudioEdit, StudioEditRefusal } from './studioEditSchemas'

type Locate = (nodeId: string) => { rel: string } | null

const AGENT_REFUSAL =
  'Loose canvas layers are the scratch space on the board and are edited in the Studio canvas; agent edit tools do not write them. Put the element in a page instead.'

/** Every node id one edit names, target first. */
function namedNodeIds(edit: StudioEdit): string[] {
  const ids = [edit.nodeId]
  if ('parentNodeId' in edit && typeof edit.parentNodeId === 'string') ids.push(edit.parentNodeId)
  if ('anchorNodeId' in edit && typeof edit.anchorNodeId === 'string') ids.push(edit.anchorNodeId)
  if ('siblingNodeIds' in edit) ids.push(...edit.siblingNodeIds)
  return ids
}

/** The batch's canvas-layer gate — see this module's doc. */
export function createCanvasLayerScope(
  scope: 'allow' | undefined,
  locate: Locate,
): (edit: StudioEdit) => StudioEditRefusal | null {
  if (scope === 'allow') return () => null
  return (edit) => {
    const touchesLayer =
      isCanvasLayerEditKind(edit.kind) ||
      namedNodeIds(edit).some((id) => isCanvasLayerEditNodeId(id) || canvasLayerIdFromRel(locate(id)?.rel ?? '') !== null)
    return touchesLayer ? refusalFor(edit, 'canvas-layer-agent', AGENT_REFUSAL) : null
  }
}
