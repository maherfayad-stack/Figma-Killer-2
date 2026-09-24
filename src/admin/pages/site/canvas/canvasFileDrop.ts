/**
 * canvasFileDrop — D2 G15: what a file dragged in from the operating system
 * means when it lands on the board.
 *
 * One gesture, one write, one toast. The whole point of this module is that
 * every way the gesture can fail is decided HERE, before a byte is uploaded:
 * a drop of something that is not an image, a drop of several files at once,
 * and — on a canvas with no free canvas (the CMS editor) — a drop on the empty
 * board. On a Studio board the empty board is the FREE CANVAS (P5-G): the image
 * becomes a loose layer there, never part of a page (`kind: 'canvas'`). Each returns a refusal with a sentence, and none
 * of them touches the network or the user's repository.
 *
 * ## Why the position is resolved as an INSERT
 *
 * The thing being dropped does not exist in any tree — it is a file on the
 * user's disk. "Which container, and where among its children" is exactly the
 * question the component picker asks (`resolveCanvasInsertionTarget`), and
 * asking it here is what makes a dropped image land where the drop indicator
 * said it would rather than always at the end.
 *
 * ## The format check here is not the format check
 *
 * `looksLikeImage` reads the browser's declared MIME type, and it exists only
 * to produce a HONEST REFUSAL SENTENCE without a round trip — "a PDF is not an
 * image" is worth saying before a 20 MB upload, not after. The authoritative
 * answer is the server's, which sniffs the actual bytes (`sniffImageExtension`)
 * and refuses a `.png`-named, `image/png`-declared file whose content is
 * something else. This one can only be MORE permissive, never less, which is
 * the only safe direction for a client-side pre-check.
 */
import { registry } from '@core/module-engine'
import type { NodeTree, PageNode } from '@core/page-tree'
import { resolveCanvasInsertionTarget, type CanvasInsertionTarget } from './canvasDnd'
import { canvasSurfaceAtPoint, measureBoardDropSurfaces } from './canvasDragBoard'
import { buildFrameCandidateIndex, indexLocalPoint, type ClientPoint } from './canvasDragSession'
import type { CanvasTransform } from './math'

export type CanvasFileDropRefusalReason =
  /** The pointer was over the empty board, not over a frame. */
  | 'no-frame'
  /** More than one file at once — each write moves the next one's line numbers. */
  | 'multiple-files'
  /** The browser says this is not an image, and names what it says it is. */
  | 'not-an-image'
  /** A frame was under the pointer but nothing in it could take a child. */
  | 'no-position'

export interface CanvasFileDropRefusal {
  reason: CanvasFileDropRefusalReason
  /**
   * The clause the cursor chip shows WHILE the file is still in the air
   * (`canvasFileDragPreview.ts`). One line, because it is read at a glance
   * next to a pointer that is still moving.
   */
  headline: string
  /** The whole sentence, for the toast a completed drop's refusal raises. */
  message: string
}

export type CanvasFileDropPlan =
  | { ok: true; kind: 'frame'; file: File; pageId: string; target: CanvasInsertionTarget }
  /**
   * P5-G — released over the empty board of a Studio board: the image becomes a
   * loose layer on the free canvas, its top-left at `at` (board units). Never
   * written into a page.
   */
  | { ok: true; kind: 'canvas'; file: File; at: { x: number; y: number } }
  | { ok: false; refusal: CanvasFileDropRefusal }

/**
 * What a dragged file is, reduced to the three things BOTH halves of the
 * gesture can see.
 *
 * The drop has real `File`s. The drag over the board does not, and cannot:
 * the HTML drag-and-drop spec puts the drag data store in "protected mode"
 * for every event before `drop`, so `DataTransfer.files` is empty and
 * `DataTransferItem.getAsFile()` returns `null` there. What IS exposed is
 * `items[i].kind` and `items[i].type` — a count and a declared MIME type, and
 * **no file name and no size**. That is why the in-flight chip names the type
 * rather than the file: naming a file Studio cannot see would be an invented
 * fact, and the whole point of showing a verdict before release is that it is
 * the same verdict.
 */
export interface DroppedFileFacts {
  /** How many file entries the drag carries. */
  count: number
  /** The browser's declared MIME type of the first entry, or `''` when it declares none. */
  type: string
  /** The first entry's file name — present only at DROP time. */
  name?: string
}

/**
 * Whether the browser thinks this is an image. See this module's doc for why
 * this is a courtesy, not the gate.
 *
 * An EMPTY declared type is treated as an image on purpose: some platforms
 * hand a dragged file over with no type at all, and refusing those would
 * refuse real images on the strength of a missing string. The server's byte
 * sniff catches whatever this lets through.
 */
export function looksLikeImage(facts: DroppedFileFacts): boolean {
  return facts.type === '' || facts.type.startsWith('image/')
}

/**
 * Everything about a dropped file that is decidable from the file ALONE —
 * how many there are and what the browser says they are.
 *
 * Its own function because it is the one part of the verdict both halves of
 * the gesture can reach: `planCanvasFileDrop` asks it at `drop` with real
 * `File`s, and the in-flight preview asks it on every `dragover` with the
 * protected-mode facts above. One rule, one sentence, two moments.
 */
export function refuseDroppedFile(facts: DroppedFileFacts): CanvasFileDropRefusal | null {
  if (facts.count === 0) {
    return {
      reason: 'not-an-image',
      headline: 'Studio could not read that file',
      message: 'That drop carried no file Studio could read.',
    }
  }
  if (facts.count > 1) {
    return {
      reason: 'multiple-files',
      headline: 'One image at a time',
      message:
        'Studio adds one image at a time: each one is written into your source, and that moves the line numbers the next one would be written against. Drop them one by one.',
    }
  }
  if (!looksLikeImage(facts)) {
    const described = describeFileType(facts)
    return {
      reason: 'not-an-image',
      headline: `${described} is not an image`,
      message: `${facts.name ? `"${facts.name}"` : 'That file'} is ${described}, and Studio only adds images this way. Drop a PNG, JPEG, WebP, AVIF, GIF or SVG.`,
    }
  }
  return null
}

/** How a file with the wrong type is described back to the user. */
function describeFileType(facts: DroppedFileFacts): string {
  if (facts.type) return facts.type
  const dot = facts.name ? facts.name.lastIndexOf('.') : -1
  if (dot === -1 || !facts.name) return 'a file with no declared type'
  return `a ${facts.name.slice(dot + 1).toLowerCase()} file`
}

/** The two refusals that need geometry, so they read the same from both halves. */
export const CANVAS_FILE_DROP_REFUSAL = {
  noFrame: {
    reason: 'no-frame',
    headline: 'Drop onto a frame',
    message:
      'Drop the image onto a frame. The empty board is not a file, so there is nowhere for Studio to write the element.',
  },
  frameGone: {
    reason: 'no-frame',
    headline: 'That frame is gone',
    message: 'That frame left the board while the image was being dropped, so nothing was added. Drop it onto a frame that is on the board now.',
  },
  noPosition: {
    reason: 'no-position',
    headline: 'Nothing here can hold an image',
    message:
      'Nothing under the pointer in that frame can hold an image. Drop it inside a container element instead.',
  },
} as const satisfies Record<string, CanvasFileDropRefusal>

export interface CanvasFileDropInput {
  files: readonly File[]
  /** Parent-document client coordinates of the drop. */
  point: ClientPoint
  /** D1's live canvas transform, for the frame rects. */
  transform: CanvasTransform | null
  /** The page tree a frame renders — the caller's one store read. */
  readPage: (pageId: string) => NodeTree<PageNode> | null
  /**
   * P5-G — the free canvas, when this canvas is a Studio board: the client
   * rect of the element at board (0, 0) and the live zoom, which is all it
   * takes to turn the drop point into a board point. Absent (a CMS canvas),
   * the empty board still refuses: there is nowhere to put the image.
   */
  freeCanvas?: { origin: { left: number; top: number }; zoom: number } | null
}

/**
 * Decide what the drop means. Pure apart from the frame-rect and candidate
 * measurements, and it never reaches the network: a refused drop costs one
 * toast and nothing else.
 */
export function planCanvasFileDrop(input: CanvasFileDropInput): CanvasFileDropPlan {
  const file = input.files[0]
  const refusal = refuseDroppedFile({
    count: input.files.length,
    type: file?.type ?? '',
    ...(file ? { name: file.name } : {}),
  })
  if (refusal || !file) {
    return { ok: false, refusal: refusal ?? CANVAS_FILE_DROP_REFUSAL.noFrame }
  }

  const board = measureBoardDropSurfaces(input.transform)
  const surface = canvasSurfaceAtPoint(board, input.point)
  if (!surface && input.freeCanvas) {
    const zoom = input.freeCanvas.zoom > 0 ? input.freeCanvas.zoom : 1
    return {
      ok: true,
      kind: 'canvas',
      file,
      at: {
        x: (input.point.x - input.freeCanvas.origin.left) / zoom,
        y: (input.point.y - input.freeCanvas.origin.top) / zoom,
      },
    }
  }
  if (!surface || !surface.pageId) {
    return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.noFrame }
  }

  const tree = input.readPage(surface.pageId)
  if (!tree) {
    return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.frameGone }
  }

  const index = buildFrameCandidateIndex(surface.viewport, tree, surface.iframe, input.transform)
  const target = resolveCanvasInsertionTarget({
    tree,
    candidates: index.candidates,
    point: indexLocalPoint(index, input.point),
    zoom: index.scale,
    canHaveChildren,
  })
  if (!target) {
    return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.noPosition }
  }

  return { ok: true, kind: 'frame', file, pageId: surface.pageId, target }
}

/** Shared with the in-flight preview so both halves resolve the same containers. */
export function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}
