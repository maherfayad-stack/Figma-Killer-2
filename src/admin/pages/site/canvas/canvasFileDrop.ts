/**
 * canvasFileDrop — D2 G15, widened by P5-B: what image files dragged in from
 * the operating system mean when they land on a frame.
 *
 * One gesture, one write, one toast. The whole point of this module is that
 * every way the gesture can fail is decided HERE, before a byte is uploaded:
 * a drop on the empty board, a drop with no image in it, a drop onto nothing
 * that can hold an image, a ⌘-drop into a container that is not positioned.
 * Each returns a refusal with a sentence, and none of them touches the network
 * or the user's repository.
 *
 * ## What a drop means (P5-B)
 *
 * Decided by {@link resolveCanvasFileDropIntent}, which the in-flight preview
 * asks on every animation frame and the drop asks once — one rule, two moments:
 *
 *   - **Onto an `<img>`** (the deepest node under the pointer declares
 *     `imageEdit`) with ONE file: REPLACE its source (IMG-3). ⌥ inserts beside
 *     it instead. Several files never replace: one image cannot become three.
 *   - **With ⇧**: set the container under the pointer's BACKGROUND image
 *     (IMG-7). One file; a background takes one image.
 *   - **Otherwise**: INSERT every image, in order, as one run of siblings at
 *     the drop position (IMG-2) — one write and one undo step, however many
 *     files. ⌘/Ctrl places the run ABSOLUTELY at the pointer, K6's rule
 *     (IMG-9, `canvasImageDropPlacement.ts`).
 *
 * The EMPTY BOARD is not a frame: a drop there refuses here (free-canvas
 * placement is P5-G's). This module only answers for drops onto frames.
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
 * the only safe direction for a client-side pre-check. A drop that mixes
 * images with other files adds the images and names what it left out.
 */
import { registry } from '@core/module-engine'
import {
  getNodeHtmlTag,
  isPropWritableToSource,
  resolveSourceContainer,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { resolveCanvasInsertionTarget, type CanvasDropCandidate, type CanvasInsertionTarget } from './canvasDnd'
import { canvasSurfaceAtPoint, measureBoardDropSurfaces } from './canvasDragBoard'
import { buildFrameCandidateIndex, indexLocalPoint, type ClientPoint } from './canvasDragSession'
import {
  measureDropContainer,
  resolveAbsolutePlacement,
  type AbsoluteImagePlacement,
  type DropContainerBox,
} from './canvasImageDropPlacement'
import type { CanvasTransform } from './math'

export type CanvasFileDropRefusalReason =
  /** The pointer was over the empty board, not over a frame. */
  | 'no-frame'
  /** Nothing the browser declared is an image. */
  | 'not-an-image'
  /** A frame was under the pointer but nothing in it could take a child. */
  | 'no-position'
  /** ⇧-drop of more than one file — a background takes one image. */
  | 'one-background'
  /** The image under the pointer takes its `src` from code Studio cannot rewrite. */
  | 'locked-image'
  /** ⌘-drop into a container that is not positioned (K6's refusal). */
  | 'static-parent'

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
  /**
   * `static-parent` only: the container K6's remedy ("make it
   * `position: relative`") acts on, so the drop opens the same one-click
   * refusal dialog a ⌘-drag does instead of a toast.
   */
  staticParent?: { parentNodeId: string | null; parentLabel: string }
}

/** The keys held at the moment of the drop (or of this preview frame). */
export interface CanvasFileDropModifiers {
  /** ⌥ — insert beside an image instead of replacing it. */
  alt: boolean
  /** ⇧ — set the container's background image instead of inserting. */
  shift: boolean
  /** ⌘ (Ctrl off macOS) — place the image absolutely at the pointer. */
  absolute: boolean
}

export const NO_DROP_MODIFIERS: CanvasFileDropModifiers = { alt: false, shift: false, absolute: false }

/** What an accepted drop will do, before a byte is uploaded. */
export type CanvasImageDropAction =
  | {
      kind: 'insert'
      /** Container and index, exactly as the drop line showed. */
      target: CanvasInsertionTarget
      /** The container's content-box width, for clamping the intrinsic size; `null` = unmeasured, no clamp. */
      maxWidth: number | null
      /** ⌘-drop: where, in the container's space. `null` for an ordinary flow drop. */
      absolute: AbsoluteImagePlacement | null
    }
  | { kind: 'replace'; nodeId: string }
  | { kind: 'background'; nodeId: string }

export type CanvasFileDropPlan =
  | {
      ok: true
      pageId: string
      /** The images, in the order they were dropped. */
      files: File[]
      /** Files the browser said are not images, left out — the toast names them. */
      skipped: File[]
      action: CanvasImageDropAction
    }
  | { ok: false; refusal: CanvasFileDropRefusal }

/**
 * What a dragged file is, reduced to what BOTH halves of the gesture can see.
 *
 * The drop has real `File`s. The drag over the board does not, and cannot:
 * the HTML drag-and-drop spec puts the drag data store in "protected mode"
 * for every event before `drop`, so `DataTransfer.files` is empty and
 * `DataTransferItem.getAsFile()` returns `null` there. What IS exposed is
 * `items[i].kind` and `items[i].type` — a count and each declared MIME type,
 * and **no file name and no size**. That is why the in-flight chip names the
 * type rather than the file: naming a file Studio cannot see would be an
 * invented fact, and the whole point of showing a verdict before release is
 * that it is the same verdict.
 */
export interface DroppedFileFacts {
  /** The browser's declared MIME type of each entry, in order; `''` when it declares none. */
  types: readonly string[]
  /** Each entry's file name — present only at DROP time. */
  names?: readonly string[]
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
export function looksLikeImage(type: string): boolean {
  return type === '' || type.startsWith('image/')
}

/** How many of the dragged entries look like images. */
export function imageCount(facts: DroppedFileFacts): number {
  return facts.types.filter(looksLikeImage).length
}

/**
 * Everything about a drop that is decidable from the files ALONE.
 *
 * Its own function because it is the one part of the verdict both halves of
 * the gesture can reach: `planCanvasFileDrop` asks it at `drop` with real
 * `File`s, and the in-flight preview asks it on every `dragover` with the
 * protected-mode facts above. One rule, one sentence, two moments.
 */
export function refuseDroppedFile(facts: DroppedFileFacts): CanvasFileDropRefusal | null {
  if (facts.types.length === 0) {
    return {
      reason: 'not-an-image',
      headline: 'Studio could not read that file',
      message: 'That drop carried no file Studio could read.',
    }
  }
  if (imageCount(facts) > 0) return null
  const described = describeFileType(facts.types[0] ?? '', facts.names?.[0])
  const name = facts.names?.[0]
  return {
    reason: 'not-an-image',
    headline: `${described} is not an image`,
    message: `${facts.types.length > 1 ? 'None of those files is an image' : `${name ? `"${name}"` : 'That file'} is ${described}`}, and Studio only adds images this way. Drop a PNG, JPEG, WebP, AVIF, GIF or SVG.`,
  }
}

/** How a file with the wrong type is described back to the user. */
function describeFileType(type: string, name: string | undefined): string {
  if (type) return type
  const dot = name ? name.lastIndexOf('.') : -1
  if (dot === -1 || !name) return 'a file with no declared type'
  return `a ${name.slice(dot + 1).toLowerCase()} file`
}

/** The refusals that need geometry, so they read the same from both halves. */
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
  oneBackground: {
    reason: 'one-background',
    headline: 'A background takes one image',
    message: 'Hold ⇧ with ONE image to make it the background of the element under the pointer. Drop several images without ⇧ to add them all.',
  },
  lockedImage: {
    reason: 'locked-image',
    headline: 'This image comes from code',
    message:
      "This image's src is computed in code, so there is no file path Studio could rewrite. Hold ⌥ to add the new image beside it instead, or change the expression in your editor.",
  },
} as const satisfies Record<string, CanvasFileDropRefusal>

function staticParentRefusal(parent: PageNode | null): CanvasFileDropRefusal {
  const parentLabel = (parent ? getNodeHtmlTag(parent, registry.get(parent.moduleId)) : null) ?? 'container'
  return {
    reason: 'static-parent',
    headline: `Make this ${parentLabel} position: relative first`,
    message: `⌘-drop places the image at the pointer, which needs a positioned container — this ${parentLabel} is position: static, so the image would be placed against some other element. Make it position: relative, or drop without ⌘ to add the image in the flow.`,
    staticParent: { parentNodeId: parent?.id ?? null, parentLabel },
  }
}

/** Everything the intent resolution reads — the same inputs whether it runs per frame or once at drop. */
export interface CanvasFileDropIntentInput {
  tree: NodeTree<PageNode>
  candidates: CanvasDropCandidate[]
  /** Frame-viewport point (`indexLocalPoint`). */
  point: ClientPoint
  zoom: number
  facts: DroppedFileFacts
  modifiers: CanvasFileDropModifiers
  /** The container's box, read at most once per container (`measureDropContainer`); only asked for a ⌘-drop. */
  measureContainer: (nodeId: string) => DropContainerBox | null
}

export type CanvasFileDropIntent =
  | { ok: true; action: CanvasImageDropAction }
  | { ok: false; refusal: CanvasFileDropRefusal; target: CanvasInsertionTarget | null }

/**
 * What this drop means here, with these keys held. Pure apart from
 * `measureContainer`, which only a ⌘-drop calls.
 */
export function resolveCanvasFileDropIntent(input: CanvasFileDropIntentInput): CanvasFileDropIntent {
  const { tree, candidates, point, zoom, facts, modifiers } = input
  const images = imageCount(facts)

  const underPointer = deepestCandidateAt(candidates, point)
  const imageNode = underPointer ? tree.nodes[underPointer.nodeId] : undefined
  const overImage = imageNode !== undefined && registry.get(imageNode.moduleId)?.imageEdit !== undefined

  if (imageNode && overImage && images === 1 && !modifiers.alt && !modifiers.shift) {
    // IMG-3 — replace. Refused when neither the import (an import-bound
    // `src={hero}`) nor the attribute itself can take a new path.
    const writable = imageNode.assetOrigin !== undefined || isPropWritableToSource(imageNode, 'src')
    if (!writable) return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.lockedImage, target: null }
    return { ok: true, action: { kind: 'replace', nodeId: imageNode.id } }
  }

  const target = resolveCanvasInsertionTarget({ tree, candidates, point, zoom, canHaveChildren })
  if (!target) return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.noPosition, target: null }

  if (modifiers.shift) {
    if (images !== 1) return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.oneBackground, target }
    const container = resolveSourceContainer(tree, target.parentId)
    if (!container.ok) return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.noPosition, target }
    return { ok: true, action: { kind: 'background', nodeId: container.node.id } }
  }

  const container = resolveSourceContainer(tree, target.parentId)
  const containerNode = container.ok ? container.node : null
  if (!modifiers.absolute) {
    return { ok: true, action: { kind: 'insert', target, maxWidth: null, absolute: null } }
  }
  const box = containerNode ? input.measureContainer(containerNode.id) : null
  const placement = resolveAbsolutePlacement(box, point)
  if (!placement.ok) return { ok: false, refusal: staticParentRefusal(containerNode), target }
  return { ok: true, action: { kind: 'insert', target, maxWidth: null, absolute: placement.placement } }
}

/** The deepest measured node whose rect contains the point — what the pointer is ON. */
function deepestCandidateAt(candidates: readonly CanvasDropCandidate[], point: ClientPoint): CanvasDropCandidate | null {
  let best: CanvasDropCandidate | null = null
  for (const candidate of candidates) {
    const { rect } = candidate
    const inside =
      point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height
    if (inside && (!best || candidate.depth > best.depth)) best = candidate
  }
  return best
}

export interface CanvasFileDropInput {
  files: readonly File[]
  /** Parent-document client coordinates of the drop. */
  point: ClientPoint
  modifiers: CanvasFileDropModifiers
  /** D1's live canvas transform, for the frame rects. */
  transform: CanvasTransform | null
  /** The page tree a frame renders — the caller's one store read. */
  readPage: (pageId: string) => NodeTree<PageNode> | null
}

/**
 * Decide what the drop means. Pure apart from the frame-rect and candidate
 * measurements (plus one container read for a ⌘-drop or an insert's size
 * clamp), and it never reaches the network: a refused drop costs one toast
 * and nothing else.
 */
export function planCanvasFileDrop(input: CanvasFileDropInput): CanvasFileDropPlan {
  const facts: DroppedFileFacts = {
    types: input.files.map((file) => file.type),
    names: input.files.map((file) => file.name),
  }
  const refusal = refuseDroppedFile(facts)
  if (refusal) return { ok: false, refusal }
  const files = input.files.filter((file) => looksLikeImage(file.type))
  const skipped = input.files.filter((file) => !looksLikeImage(file.type))

  const board = measureBoardDropSurfaces(input.transform)
  const surface = canvasSurfaceAtPoint(board, input.point)
  if (!surface || !surface.pageId) {
    return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.noFrame }
  }

  const tree = input.readPage(surface.pageId)
  if (!tree) {
    return { ok: false, refusal: CANVAS_FILE_DROP_REFUSAL.frameGone }
  }

  const index = buildFrameCandidateIndex(surface.viewport, tree, surface.iframe, input.transform)
  const doc = surface.iframe?.contentDocument ?? null
  const measureContainer = (nodeId: string) => (doc ? measureDropContainer(doc, nodeId) : null)
  const intent = resolveCanvasFileDropIntent({
    tree,
    candidates: index.candidates,
    point: indexLocalPoint(index, input.point),
    zoom: index.scale,
    facts: { types: files.map((file) => file.type) },
    modifiers: input.modifiers,
    measureContainer,
  })
  if (!intent.ok) return { ok: false, refusal: intent.refusal }

  const action = intent.action
  if (action.kind !== 'insert') return { ok: true, pageId: surface.pageId, files, skipped, action }

  // IMG-9 — the width the intrinsic size is clamped to: the container's own
  // content box, read once, now that the drop is certain.
  const container = resolveSourceContainer(tree, action.target.parentId)
  const box = container.ok ? measureContainer(container.node.id) : null
  return {
    ok: true,
    pageId: surface.pageId,
    files,
    skipped,
    action: { ...action, maxWidth: box ? box.contentWidth : null },
  }
}

/** Shared with the in-flight preview so both halves resolve the same containers. */
export function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}
