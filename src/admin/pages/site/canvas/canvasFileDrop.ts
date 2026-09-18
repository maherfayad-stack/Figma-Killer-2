/**
 * canvasFileDrop — D2 G15: what a file dragged in from the operating system
 * means when it lands on the board.
 *
 * One gesture, one write, one toast. The whole point of this module is that
 * every way the gesture can fail is decided HERE, before a byte is uploaded:
 * a drop on the empty board, a drop of something that is not an image, a drop
 * of several files at once. Each returns a refusal with a sentence, and none
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

export type CanvasFileDropRefusal =
  /** The pointer was over the empty board, not over a frame. */
  | { reason: 'no-frame'; message: string }
  /** More than one file at once — each write moves the next one's line numbers. */
  | { reason: 'multiple-files'; message: string }
  /** The browser says this is not an image, and names what it says it is. */
  | { reason: 'not-an-image'; message: string }
  /** A frame was under the pointer but nothing in it could take a child. */
  | { reason: 'no-position'; message: string }

export type CanvasFileDropPlan =
  | { ok: true; file: File; pageId: string; target: CanvasInsertionTarget }
  | { ok: false; refusal: CanvasFileDropRefusal }

/**
 * Whether the browser thinks this file is an image. See this module's doc for
 * why this is a courtesy, not the gate.
 *
 * An EMPTY declared type is treated as an image on purpose: some platforms
 * hand a dragged file over with no type at all, and refusing those would
 * refuse real images on the strength of a missing string. The server's byte
 * sniff catches whatever this lets through.
 */
export function looksLikeImage(file: File): boolean {
  return file.type === '' || file.type.startsWith('image/')
}

/** How a file with the wrong type is described back to the user. */
function describeFileType(file: File): string {
  if (file.type) return file.type
  const dot = file.name.lastIndexOf('.')
  return dot === -1 ? 'a file with no extension' : `a ${file.name.slice(dot + 1).toLowerCase()} file`
}

export interface CanvasFileDropInput {
  files: readonly File[]
  /** Parent-document client coordinates of the drop. */
  point: ClientPoint
  /** D1's live canvas transform, for the frame rects. */
  transform: CanvasTransform | null
  /** The page tree a frame renders — the caller's one store read. */
  readPage: (pageId: string) => NodeTree<PageNode> | null
}

/**
 * Decide what the drop means. Pure apart from the frame-rect and candidate
 * measurements, and it never reaches the network: a refused drop costs one
 * toast and nothing else.
 */
export function planCanvasFileDrop(input: CanvasFileDropInput): CanvasFileDropPlan {
  const [file, ...rest] = input.files
  if (!file) {
    return {
      ok: false,
      refusal: { reason: 'not-an-image', message: 'That drop carried no file Studio could read.' },
    }
  }
  if (rest.length > 0) {
    return {
      ok: false,
      refusal: {
        reason: 'multiple-files',
        message:
          'Studio adds one image at a time: each one is written into your source, and that moves the line numbers the next one would be written against. Drop them one by one.',
      },
    }
  }
  if (!looksLikeImage(file)) {
    return {
      ok: false,
      refusal: {
        reason: 'not-an-image',
        message: `"${file.name}" is ${describeFileType(file)}, and Studio only adds images this way. Drop a PNG, JPEG, WebP, AVIF, GIF or SVG.`,
      },
    }
  }

  const board = measureBoardDropSurfaces(input.transform)
  const surface = canvasSurfaceAtPoint(board, input.point)
  if (!surface || !surface.pageId) {
    return {
      ok: false,
      refusal: {
        reason: 'no-frame',
        message:
          'Drop the image onto a frame. The empty board is not a file, so there is nowhere for Studio to write the element.',
      },
    }
  }

  const tree = input.readPage(surface.pageId)
  if (!tree) {
    return {
      ok: false,
      refusal: {
        reason: 'no-frame',
        message: 'That frame is no longer on the board. Reload the project and try again.',
      },
    }
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
    return {
      ok: false,
      refusal: {
        reason: 'no-position',
        message:
          'Nothing under the pointer in that frame can hold an image. Drop it inside a container element instead.',
      },
    }
  }

  return { ok: true, file, pageId: surface.pageId, target }
}

function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}
