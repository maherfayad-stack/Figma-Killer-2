/**
 * canvasFileDragPreview — what a file dragged in from the operating system
 * looks like BEFORE it is released.
 *
 * ## The gap this closes
 *
 * G15 landed the write (`canvasFileDrop.ts`) with no in-flight feedback at
 * all: an image dragged over the board showed the browser's own copy cursor
 * and nothing else, and every refusal — a PDF, the empty board, a frame with
 * no container under the pointer — arrived as a toast AFTER the user had let
 * go. An element drag has said all of this while the pointer is still down
 * since G5. This makes the file drag say the same things, through the same
 * painter, in the same places.
 *
 * ## One verdict, two moments
 *
 * Every refusal here comes from `canvasFileDrop.ts` — `refuseDroppedFile` for
 * the file itself, `CANVAS_FILE_DROP_REFUSAL` for the two that need geometry.
 * The preview is not a second rule that happens to agree; it is the same rule
 * asked earlier, which is the only arrangement in which the chip and the toast
 * cannot drift apart.
 *
 * **What the chip can honestly say is narrower than what the toast can.**
 * Before `drop`, the drag data store is in the spec's "protected mode":
 * `DataTransfer.files` is empty and `getAsFile()` returns `null`, so there is
 * no file name and no size to show — only `items[i].kind` and `items[i].type`.
 * The chip therefore names the TYPE. See `DroppedFileFacts`.
 *
 * ## Why it reuses the element drag's own board machinery
 *
 * `measureBoardDropSurfaces` / `refreshBoardDropSurfaces` /
 * `resolveForeignFrameDrop` are exactly the questions a file drag asks — which
 * frame is under the pointer, what is that frame's tree, what are its
 * candidate rects — and they already cache on the right signals (a transform
 * change, a registry change, and a frame's candidates measured once on entry).
 * A file drag has no origin frame to be "foreign" to, so it passes
 * `originPageId: null` and every frame with a page qualifies. Reusing them is
 * also what keeps `frameVirtualization`'s viewport test the only one there is.
 *
 * ## Where the chrome is painted
 *
 * Over a frame: that frame's own drag layer, in frame space — the same layer,
 * the same painter and the same `--canvas-drop-*` channel an element drag
 * uses, so the drop line a file gets is the drop line an element gets.
 *
 * Over the empty board there is no frame and therefore no frame layer, so the
 * cursor chip goes in the board-level hint layer (`CanvasFileDropHint`), which
 * is a sibling of the transform layer in PARENT-document client space. That is
 * the whole reason the two coordinate spaces exist here.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import {
  refreshBoardDropSurfaces,
  resolveForeignFrameDrop,
  type BoardDropSurfaces,
  type ForeignFrameDrop,
} from './canvasDragBoard'
import type { CanvasDragPaint } from './canvasDragPainter'
import { indexLocalPoint, type ClientPoint } from './canvasDragSession'
import { dropParentOutlineRect } from './canvasDropParentOutline'
import {
  CANVAS_FILE_DROP_REFUSAL,
  imageCount,
  refuseDroppedFile,
  resolveCanvasFileDropIntent,
  type CanvasFileDropModifiers,
  type CanvasImageDropAction,
  type DroppedFileFacts,
} from './canvasFileDrop'
import { measureDropContainer, type DropContainerBox } from './canvasImageDropPlacement'
import type { CanvasTransform } from './math'

/** What one in-flight file drag knows, carried across its `dragover` stream. */
export interface CanvasFileDragSession {
  board: BoardDropSurfaces
  /** The frame the pointer is inside, with its tree and candidates. Measured on entry. */
  frame: ForeignFrameDrop | null
  /** The ONE layer currently carrying chrome, so the other can be cleared. */
  paintedLayer: HTMLElement | null
  /**
   * Container boxes a ⌘-drop has asked about, per frame visit — one
   * computed-style read per container, not one per animation frame. Cleared
   * whenever the pointer enters a different frame.
   */
  containerBoxes: Map<string, DropContainerBox | null>
}

/** Everything one preview frame needs from the hook that owns the session. */
export interface CanvasFileDragPreviewEnv {
  point: ClientPoint
  /** What the browser will admit about the dragged files before release. */
  facts: DroppedFileFacts
  /** The keys held on this `dragover` — they change what the drop means. */
  modifiers: CanvasFileDropModifiers
  transform: CanvasTransform | null
  readPage: (pageId: string) => NodeTree<PageNode> | null
  /**
   * The board-level chip layer and its client origin — `null` when it has not
   * mounted. Its own space: it is a sibling of the transform layer, so a point
   * goes in as plain client coordinates minus this origin.
   */
  hintLayer: HTMLElement | null
  hintOrigin: ClientPoint | null
}

/** Where the chrome for this frame goes, and what it says. */
export interface CanvasFileDragPaint {
  layer: HTMLElement | null
  paint: CanvasDragPaint | null
}

export function beginCanvasFileDragSession(board: BoardDropSurfaces): CanvasFileDragSession {
  return { board, frame: null, paintedLayer: null, containerBoxes: new Map() }
}

/**
 * Resolve one animation frame of a file drag: which layer to paint, and what.
 *
 * READ phase only — it measures (through the board cache, plus at most one
 * container read per container for a ⌘-drop) and decides, and returns the
 * paint for the caller to write. Nothing here touches a style.
 */
export function resolveCanvasFileDragPaint(
  session: CanvasFileDragSession,
  env: CanvasFileDragPreviewEnv,
): CanvasFileDragPaint {
  const fileRefusal = refuseDroppedFile(env.facts)

  session.board = refreshBoardDropSurfaces(session.board, env.transform)
  const frame = resolveForeignFrameDrop(
    session.board,
    env.point,
    null,
    session.frame,
    env.transform,
    env.readPage,
  )
  if (frame !== session.frame) session.containerBoxes.clear()
  session.frame = frame

  // Over the empty board: no frame, no drop line, and the chip has to go in
  // the board-level layer because there is no frame layer to put it in.
  if (!frame) {
    if (!env.hintLayer || !env.hintOrigin) return { layer: null, paint: null }
    return {
      layer: env.hintLayer,
      paint: {
        target: null,
        invalid: null,
        ghost: {
          point: { x: env.point.x - env.hintOrigin.x, y: env.point.y - env.hintOrigin.y },
          label: (fileRefusal ?? CANVAS_FILE_DROP_REFUSAL.noFrame).headline,
          duplicating: false,
          refusing: true,
        },
      },
    }
  }

  const layer = frame.surface.dropLayer()
  const point = indexLocalPoint(frame.index, env.point)
  const doc = frame.surface.iframe?.contentDocument ?? null
  const intent = resolveCanvasFileDropIntent({
    tree: frame.tree,
    candidates: frame.index.candidates,
    point,
    zoom: frame.index.scale,
    facts: env.facts,
    modifiers: env.modifiers,
    measureContainer: (nodeId) => {
      if (!session.containerBoxes.has(nodeId)) {
        session.containerBoxes.set(nodeId, doc ? measureDropContainer(doc, nodeId) : null)
      }
      return session.containerBoxes.get(nodeId) ?? null
    },
  })

  if (fileRefusal || !intent.ok) {
    const refusal = fileRefusal ?? (intent.ok ? null : intent.refusal)
    const target = intent.ok ? null : intent.target
    // A refused file gets no drop line, for the reason an element drag gets
    // none: a line is a promise about where the thing lands.
    return {
      layer,
      paint: {
        target: null,
        invalid: target ? { overId: target.overId, rect: target.rect, axis: target.axis } : null,
        ghost: { point, label: refusal?.headline ?? '', duplicating: false, refusing: true },
      },
    }
  }

  const action = intent.action
  const label = describeDropAction(action, env.facts)
  if (action.kind === 'insert') {
    const { target } = action
    return {
      layer,
      paint: {
        target: { rect: target.rect, axis: target.axis, position: target.position },
        invalid: null,
        ghost: { point, label, duplicating: false },
        parent: dropParentOutlineRect(target, frame.index.candidates),
      },
    }
  }
  // Replace / background: the element that will change is outlined (P2-E's
  // drop-target outline), and there is no drop line — nothing is inserted.
  return {
    layer,
    paint: {
      target: null,
      invalid: null,
      ghost: { point, label, duplicating: false },
      parent: frame.index.candidates.find((candidate) => candidate.nodeId === action.nodeId)?.rect ?? null,
    },
  }
}

/** What the chip says about a drop that IS going to land. */
export function describeDropAction(action: CanvasImageDropAction, facts: DroppedFileFacts): string {
  if (action.kind === 'replace') return 'Replace image'
  if (action.kind === 'background') return 'Set as background'
  const count = imageCount(facts)
  const what = count > 1 ? `Add ${count} images` : describeDraggedImage(facts.types.find((type) => type === '' || type.startsWith('image/')) ?? '')
  return action.absolute ? `${what} at the pointer` : what
}

/**
 * What the chip says about ONE file that is going to land.
 *
 * The declared MIME type, shortened to the subtype every user already reads as
 * a format ("PNG", "SVG"), because that is the only thing about the file the
 * browser will tell us before release — not its name, and not its size. An
 * empty type is the platform declaring nothing at all, which
 * `looksLikeImage` deliberately lets through, so the chip says the one thing
 * that is still true.
 */
export function describeDraggedImage(type: string): string {
  if (!type) return 'Image file'
  const subtype = type.slice(type.indexOf('/') + 1)
  return subtype ? `${subtype.replace(/^svg\+xml$/, 'svg').toUpperCase()} image` : 'Image file'
}

/**
 * The protected-mode facts about a drag that is still in the air.
 *
 * `items` is the only readable half of a `DataTransfer` before `drop` — `kind`
 * and `type`, never the bytes and never the name. Returns `null` when the drag
 * carries no files at all, which is every ordinary in-page HTML5 drag and must
 * be left completely alone.
 */
export function readDraggedFileFacts(transfer: DataTransfer | null): DroppedFileFacts | null {
  if (!transfer) return null
  const items = transfer.items ? Array.from(transfer.items) : []
  const files = items.filter((item) => item.kind === 'file')
  if (files.length === 0) {
    // Safari exposes `types` but not always a populated `items` list for a
    // file drag. `types` including `Files` is the spec's own signal, so a drag
    // that claims files but enumerates none is still a file drag — with one
    // entry of no declared type, which is the only assumption that does not
    // refuse a real image drop on a browser that told us less.
    const claimsFiles = Array.from(transfer.types ?? []).includes('Files')
    return claimsFiles ? { types: [''] } : null
  }
  return { types: files.map((item) => item.type) }
}

/** The keys a drag event carries, as the drop's modifiers. ⌘ on macOS, Ctrl elsewhere — either reads as "place here". */
export function dropModifiersOf(event: Pick<MouseEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>): CanvasFileDropModifiers {
  return { alt: event.altKey, shift: event.shiftKey, absolute: event.metaKey || event.ctrlKey }
}
