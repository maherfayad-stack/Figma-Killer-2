/**
 * imageDropShapes — the pure half of an image drop (P5-B): what the canvas
 * hands the store, and the size/position maths every drop's props are built
 * from. A LEAF on purpose: `types.ts` names `ImageDropRequest`, the store's
 * actions build props with these functions, and the canvas plans against the
 * same shapes, so nothing here may import the store, the canvas or the DOM —
 * any of those would close an import cycle through `store.ts`.
 *
 * The one DOM-touching piece of the gesture, painting upload progress onto the
 * rendered ghost, is INJECTED ({@link UploadProgressPainter}) by the canvas
 * caller (`canvasUploadProgress.ts`) for the same reason.
 */
import type { InlineOffsetProperty } from '@core/studio-runtime'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'

/** The attribute the ghost carries while its bytes upload — `EditorChromeInjector`'s selector. */
export const UPLOADING_ATTRIBUTE = 'data-studio-uploading'
/** The custom property the upload's progress (0..1) is written into. */
export const UPLOAD_PROGRESS_PROPERTY = '--studio-upload-progress'

/**
 * Paints an upload's progress onto every rendered element of `nodeId` (the
 * ghost, or the `<img>` being replaced); `null` clears it. Supplied by the
 * canvas, which owns the frame documents.
 */
export type UploadProgressPainter = (nodeId: string, fraction: number | null) => void

/** Where a ⌘-dropped image goes, in the container's own space (K6's rule). */
export interface AbsoluteImagePlacement {
  property: InlineOffsetProperty
  inline: number
  top: number
}

/**
 * Where one dropped image comes from — every intake reduced to one shape
 * (audit 07 §A.2: "one intake function turns every source into one list, then
 * one landing call, then one placement"). The store's actions and the free
 * canvas land every kind through `landImageSource` (`studio/landImageSource.ts`)
 * and never branch on how the image arrived after that.
 *
 *   - `file` — bytes from the operating system (a drop, the ⇧K picker), or a
 *     `data:image/…` URL a browser handed over, decoded to a `File` client-side
 *     so the server never parses `data:`.
 *   - `url` — an http(s) image dragged out of another browser tab (IMG-5,
 *     OD-13). The SERVER fetches it, through the SSRF guard; the browser never
 *     does.
 *   - `project` — a file already in the project, dragged from the Assets
 *     panel's Images section (IMG-6). Nothing is uploaded: the insert only
 *     references it.
 */
export type ImageDropSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string }
  | {
      kind: 'project'
      /** Workspace-relative POSIX path. */
      relPath: string
      /** The URL the project's own site serves it at (`assetSiteUrl.ts`), `null` when nothing does. */
      src: string | null
      /** True when a production build serves `src`, not only the dev server. */
      buildSafe: boolean
      /** Intrinsic size, when the panel's thumbnail already knew it; `null` = unknown. */
      width: number | null
      height: number | null
    }

/** The sources that bring NEW bytes (a replace or a background has to land something). */
export type LandableImageSource = Extract<ImageDropSource, { kind: 'file' | 'url' }>

/**
 * The name a source is called by — the base of its `alt` and of every toast
 * that mentions it. A URL is named by the last segment of its path, which is
 * what the browser tab it came from showed; a project file by its own name.
 */
export function imageSourceName(source: ImageDropSource): string {
  if (source.kind === 'file') return source.file.name
  if (source.kind === 'project') return source.relPath.slice(source.relPath.lastIndexOf('/') + 1)
  try {
    const path = new URL(source.url).pathname
    const last = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
    return last.length > 0 ? last : 'image'
  } catch {
    return 'image'
  }
}

/** Everything an image INSERT drop carries from the canvas to the store. */
export interface ImageDropRequest {
  pageId: string
  /** The container and index the drop line showed; `undefined` appends. */
  parentId: string
  index: number | undefined
  /** The images, in drop order. */
  sources: readonly ImageDropSource[]
  /** The container's content-box width (CSS px) the intrinsic size is clamped to; `null` = do not clamp. */
  maxWidth: number | null
  /** ⌘-drop: the absolute placement in the container's space; `null` for a flow drop. */
  absolute: AbsoluteImagePlacement | null
  /** Paints each ghost's upload progress; omitted, nothing is painted. */
  paintProgress?: UploadProgressPainter
}

/**
 * P5-A — a JSX subtree (a pasted SVG, converted and sanitised by
 * `svgToJsxNode`) written at the position a gesture named
 * (`insertJsxSubtreeIntoPage`). Here beside the image drop's request because
 * both are what the canvas hands the store for a gesture-addressed insert.
 */
export interface SubtreeInsertRequest {
  pageId: string
  /** The container and index the new element is written at. */
  parentId: string
  index: number
  /** The element and everything under it, written in one splice. */
  node: SlotJsxNode
  /** What ⌘Z names this step. */
  undoLabel: string
}

/**
 * The `width`/`height` attributes a dropped image is written with (IMG-9):
 * its intrinsic size, scaled down (never up) to `maxWidth` with the aspect
 * kept, rounded to whole pixels. `null` when either dimension is unknown —
 * guessing one would put a number in the user's source that nothing measured.
 */
export function clampImageSize(
  intrinsic: { width: number | null; height: number | null },
  maxWidth: number | null,
): { width: number; height: number } | null {
  const { width, height } = intrinsic
  if (width === null || height === null || width <= 0 || height <= 0) return null
  if (maxWidth === null || maxWidth <= 0 || width <= maxWidth) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const scale = maxWidth / width
  return { width: Math.round(maxWidth), height: Math.max(1, Math.round(height * scale)) }
}

/** How far each further ⌘-dropped image is offset from the one before it. */
export const IMAGE_CASCADE_STEP_PX = 24

/**
 * The `style={{…}}` object the Nth ⌘-dropped image is written with: K6's
 * `position: absolute` plus the offsets. Several images cascade down-and-inward
 * by a fixed step, the way a stack of pasted pictures lands, rather than all
 * sitting exactly on top of each other where only the last could be seen.
 */
export function absolutePlacementStyle(
  placement: AbsoluteImagePlacement,
  cascadeStep: number,
): Record<string, string> {
  const offset = cascadeStep * IMAGE_CASCADE_STEP_PX
  return {
    position: 'absolute',
    [placement.property]: `${placement.inline + offset}px`,
    top: `${placement.top + offset}px`,
  }
}
