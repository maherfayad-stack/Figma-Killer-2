/**
 * studioCanvasLayerWriteback — the free canvas's edit kinds (P5-G, FC-2),
 * folded into the ordinary `/save` batch: no new route (design §3.3).
 *
 * | kind | writes |
 * |---|---|
 * | `canvas-layer-create`  | a NEW layer module whose root is an element spec (an image dropped on the empty board) |
 * | `canvas-layer-delete`  | removes a layer module and reports its bytes (its undo is `restore`) |
 * | `canvas-layer-restore` | writes a removed module back, byte for byte — an undo, never a gesture |
 * | `canvas-layer-place`   | a layer's root written into a container in a page (a drag into a frame); the module is removed unless `copy` |
 * | `canvas-layer-lift`    | a page element becomes a NEW layer module (a drag out of a frame onto the board); cut from the page unless `copy` |
 *
 * ## Paths come from ids, never from the client
 *
 * No kind here carries a file path. `layerId` is validated against the one id
 * grammar (`CanvasLayerIdSchema`) at the wire, and every file under
 * `.studio/canvas/` is reached through `canvasLayerFiles.ts`, which builds the
 * path from the id and refuses a link anywhere on the way. `place` and `lift`
 * ALSO carry node ids (the layer's root, the page element, the destination
 * container); those decode through the batch's ordinary `studioEditLocation`
 * guard, and `place` additionally requires its node id to be in the layer
 * module its `layerId` names — so a crafted batch cannot place one file's
 * markup while deleting another.
 *
 * ## Who may run these
 *
 * The editor, through `POST /admin/api/studio/save`, which is the only caller
 * that passes `canvasLayers: 'allow'` to `applyStudioEditBatch`. An agent's
 * `studio_apply_edits` does not: every canvas-layer kind, and every edit whose
 * target decodes into a layer module, is refused there by name
 * ({@link refuseAgentCanvasLayerEdit}). The agent's NATIVE file tools were
 * already refused `.studio/` entirely (`agentWriteScope.ts`) and still are.
 * That is a deliberate decision (FC-1): loose layers are the human's scratch
 * space, and the agent gets its own narrow tools for them in FC-8
 * (`studio_list_canvas_layers` / `studio_canvas_layer`), not a side door.
 */
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  canvasLayerIdFromRel,
  canvasLayerRelPath,
  CanvasLayerIdSchema,
  isCanvasLayerEditNodeId,
  type CanvasLayerId,
} from '@core/studio-board'
import {
  canvasLayerModuleFromSpec,
  liftJsxElementToCanvasModule,
  placeCanvasLayerRoot,
  type CreatedJsxLocation,
  type DeletedJsxText,
  type InsertJsxNode,
} from '@core/ast-codemods'
import { DesignSystemImportSchema, InsertNodeSchema, InsertPropsSchema } from './studioInsertJsxSchemas'
import {
  CANVAS_LAYER_MAX_BYTES,
  CanvasLayerFileError,
  canvasLayerFilePath,
  removeCanvasLayerFile,
  writeNewCanvasLayerFile,
} from './studio/canvasLayerFiles'
import { resolveDesignSystemImports } from './studioStructuralWriteback'
import { refusalFor, StudioEditRefusalError } from './studioEditRefusals'
import type { StudioEdit, StudioEditRefusal } from './studioEditSchemas'

const PositionSchema = Type.Union([Type.Literal('before'), Type.Literal('after')])

/**
 * A new layer's root element — `insert`'s element fields, exactly: an
 * intrinsic tag with no import, a component with an `importSpecifier`, or a
 * built-in design-system component whose specifier the server computes for
 * the module's own location.
 */
const CanvasLayerElementSchema = Type.Object({
  name: Type.String(),
  importSpecifier: Type.Optional(Type.String()),
  designSystemImport: Type.Optional(DesignSystemImportSchema),
  children: Type.Optional(Type.Union([Type.String(), Type.Array(InsertNodeSchema)])),
  props: Type.Optional(InsertPropsSchema),
})

/** `nodeId` is the synthetic `canvas-layer:<id>` — the file does not exist yet. */
const CanvasLayerCreateEditSchema = Type.Object({
  kind: Type.Literal('canvas-layer-create'),
  nodeId: Type.String(),
  layerId: CanvasLayerIdSchema,
  element: CanvasLayerElementSchema,
})

const CanvasLayerDeleteEditSchema = Type.Object({
  kind: Type.Literal('canvas-layer-delete'),
  nodeId: Type.String(),
  layerId: CanvasLayerIdSchema,
})

/**
 * An undo writing back what a `delete` or a `place` removed. `text` is that
 * write's own reported bytes; the write is EXCLUSIVE (a module already at the
 * id is never overwritten) and capped at `CANVAS_LAYER_MAX_BYTES`.
 */
const CanvasLayerRestoreEditSchema = Type.Object({
  kind: Type.Literal('canvas-layer-restore'),
  nodeId: Type.String(),
  layerId: CanvasLayerIdSchema,
  text: Type.String({ maxLength: CANVAS_LAYER_MAX_BYTES }),
})

/** `nodeId` is the layer's ROOT element (in its module); `parentNodeId` the page container it lands in. */
const CanvasLayerPlaceEditSchema = Type.Object({
  kind: Type.Literal('canvas-layer-place'),
  nodeId: Type.String(),
  layerId: CanvasLayerIdSchema,
  parentNodeId: Type.String(),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(PositionSchema),
  copy: Type.Optional(Type.Boolean()),
})

/** `nodeId` is the page element being lifted; `layerId` the NEW module's id (the client mints it). */
const CanvasLayerLiftEditSchema = Type.Object({
  kind: Type.Literal('canvas-layer-lift'),
  nodeId: Type.String(),
  layerId: CanvasLayerIdSchema,
  copy: Type.Optional(Type.Boolean()),
})

export const CanvasLayerEditSchemas = [
  CanvasLayerCreateEditSchema,
  CanvasLayerDeleteEditSchema,
  CanvasLayerRestoreEditSchema,
  CanvasLayerPlaceEditSchema,
  CanvasLayerLiftEditSchema,
] as const

const CanvasLayerEditSchema = Type.Union([...CanvasLayerEditSchemas])
export type CanvasLayerEdit = Static<typeof CanvasLayerEditSchema>

/** Whether an edit is one of the five — a type guard, so the batch's dispatcher narrows past them. */
export function isCanvasLayerEdit(edit: { kind: string }): edit is CanvasLayerEdit {
  return isCanvasLayerEditKind(edit.kind)
}

/** The five kinds, for the batch's `kind`-based branching. */
export function isCanvasLayerEditKind(kind: string): kind is CanvasLayerEdit['kind'] {
  return (
    kind === 'canvas-layer-create' ||
    kind === 'canvas-layer-delete' ||
    kind === 'canvas-layer-restore' ||
    kind === 'canvas-layer-place' ||
    kind === 'canvas-layer-lift'
  )
}


/** A decoded, path-guarded location — the batch's `studioEditLocation`, passed in so this module never imports the router back. */
type Locate = (nodeId: string) => { rel: string; line: number; col: number } | null

/**
 * The files one edit writes beyond whatever its own `nodeId` decodes to —
 * empty for every other kind. For these: the layer module always (a create's
 * and a lift's does not exist yet, so nothing else names it), and a place's
 * destination page. The batch needs both in its touched set, or its
 * line-count check and its created-id resolution would never see them.
 */
export function canvasLayerTouchedFiles(dir: string, edit: { kind: string }, locate: Locate): string[] {
  if (!isCanvasLayerEdit(edit)) return []
  const files = [join(dir, ...canvasLayerRelPath(edit.layerId).split('/'))]
  if (edit.kind === 'canvas-layer-place') {
    const destination = locate(edit.parentNodeId)
    if (destination) files.push(join(dir, destination.rel))
  }
  return files
}

/** A node id whose FILE is the layer module — how `created` positions are pinned to it. */
export function canvasLayerFileNodeId(id: CanvasLayerId): string {
  return `${canvasLayerRelPath(id)}:1:1`
}

/** What one canvas-layer edit did — the subset of `StudioEditApplyOutcome` these kinds produce. */
export interface CanvasLayerEditOutcome {
  applied: true
  created?: CreatedJsxLocation | null
  createdIn?: string
  removed?: DeletedJsxText
}

/** Run one canvas-layer edit. Every decline throws the batch's own `StudioEditRefusalError`, by name. */
export function applyCanvasLayerEdit(dir: string, edit: CanvasLayerEdit, locate: Locate): CanvasLayerEditOutcome {
  try {
    return dispatch(dir, edit, locate)
  } catch (err) {
    if (err instanceof CanvasLayerFileError) throw new StudioEditRefusalError(err.reason, err.message)
    throw err
  }
}

function dispatch(dir: string, edit: CanvasLayerEdit, locate: Locate): CanvasLayerEditOutcome {
  const layerNodeId = canvasLayerFileNodeId(edit.layerId)
  switch (edit.kind) {
    case 'canvas-layer-create': {
      const [root] = resolveDesignSystemImports([edit.element], canvasLayerRelPath(edit.layerId))
      const built = canvasLayerModuleFromSpec(root as InsertJsxNode)
      if (!built.ok) throw new StudioEditRefusalError(built.refusal.reason, built.refusal.message)
      writeNewCanvasLayerFile(dir, edit.layerId, built.module.text)
      return { applied: true, created: built.module.root, createdIn: layerNodeId }
    }
    case 'canvas-layer-delete':
      return { applied: true, removed: { text: removeCanvasLayerFile(dir, edit.layerId), wholeLine: false } }
    case 'canvas-layer-restore':
      writeNewCanvasLayerFile(dir, edit.layerId, edit.text)
      return { applied: true }
    case 'canvas-layer-place': {
      const root = locate(edit.nodeId)
      // The root must BE in the module `layerId` names: the module that gets
      // deleted and the markup that gets written are one and the same file.
      if (!root || canvasLayerIdFromRel(root.rel) !== edit.layerId) {
        throw new StudioEditRefusalError('not-found', 'That canvas layer is no longer where the canvas last read it. Reload the project and try again.')
      }
      const destination = locate(edit.parentNodeId)
      if (!destination || canvasLayerIdFromRel(destination.rel) !== null) {
        throw new StudioEditRefusalError('not-found', 'The frame this layer would land in is no longer backed by a page file Studio can write. Reload the project and try again.')
      }
      const anchor = edit.anchorNodeId ? locate(edit.anchorNodeId) : null
      const result = placeCanvasLayerRoot({
        moduleFile: join(dir, root.rel),
        destinationFile: join(dir, destination.rel),
        destinationLine: destination.line,
        destinationCol: destination.col,
        ...(anchor && anchor.rel === destination.rel
          ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position ?? 'before' }
          : {}),
      })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      // The page has the markup now; a move takes the layer off the canvas.
      const removed = edit.copy ? undefined : { text: removeCanvasLayerFile(dir, edit.layerId), wholeLine: false }
      return { applied: true, created: result.created, createdIn: edit.parentNodeId, ...(removed ? { removed } : {}) }
    }
    case 'canvas-layer-lift': {
      const origin = locate(edit.nodeId)
      if (!origin || canvasLayerIdFromRel(origin.rel) !== null) {
        throw new StudioEditRefusalError('not-found', 'That element is no longer where the canvas last read it. Reload the project and try again.')
      }
      const moduleFile = canvasLayerFilePath(dir, edit.layerId)
      if (!moduleFile) {
        throw new StudioEditRefusalError('layer-unsafe-path', "This project's canvas-layer folder is not an ordinary folder, so Studio will not write canvas layers into it.")
      }
      const result = liftJsxElementToCanvasModule({
        file: join(dir, origin.rel),
        line: origin.line,
        col: origin.col,
        moduleFile,
        ...(edit.copy ? { copy: true } : {}),
        writeModule: (text) => {
          writeNewCanvasLayerFile(dir, edit.layerId, text)
        },
      })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true, created: result.root, createdIn: layerNodeId }
    }
  }
}

/** Every node id one edit names, target first. */
function namedNodeIds(edit: StudioEdit): string[] {
  const ids = [edit.nodeId]
  if ('parentNodeId' in edit && typeof edit.parentNodeId === 'string') ids.push(edit.parentNodeId)
  if ('anchorNodeId' in edit && typeof edit.anchorNodeId === 'string') ids.push(edit.anchorNodeId)
  if ('siblingNodeIds' in edit) ids.push(...edit.siblingNodeIds)
  return ids
}

/**
 * The batch's canvas-layer scope: `'allow'` for the editor's own `/save`,
 * anything else (every agent tool) refuses a canvas-layer kind, and any edit
 * whose target, anchor or destination decodes into a layer module, by name.
 * See this module's doc for the decision.
 */
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

const AGENT_REFUSAL =
  'Loose canvas layers are the scratch space on the board and are edited in the Studio canvas; agent edit tools do not write them. Put the element in a page instead.'

