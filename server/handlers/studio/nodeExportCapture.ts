/**
 * nodeExportCapture — a PNG of ONE node, cut out of a capture of its page.
 *
 * ## Why this reuses the capture pipeline rather than rasterising a node
 *
 * There is no such thing as rendering a node on its own. What a node looks
 * like is decided by the cascade above it, the layout box its parent gave it,
 * and the fonts the page loaded — photograph it in isolation and you get a
 * picture of something the user has never seen. So the page is captured
 * exactly the way `studio_screenshot` and the share snapshot capture it
 * (`server/ai/mcp/capture/captureFrames.ts`), and the node's own rectangle is
 * cut out of the result.
 *
 * That rectangle is not guesswork either: every capture already reports
 * `nodeRects` — each node's frame-local CSS-pixel box, measured in the same
 * render that produced the pixels — plus an `imageScale`, the ratio between
 * those CSS pixels and the image's real ones. Multiplying one by the other is
 * the whole of the crop, and `resolveNodeCropBox` is that multiplication with
 * its edge cases named.
 *
 * ## The scale the caller asks for is a request, not a promise
 *
 * `scale` becomes the capture's `dpr`, which the capture pipeline clamps
 * against its own resolution caps (`effectiveCaptureRatio`) — a 3× export of
 * a very tall frame comes back at less. Because the crop is derived from the
 * capture's REPORTED `imageScale` rather than from the requested `scale`, the
 * cut is correct either way, and the result reports the scale actually
 * achieved so the caller can be honest about it.
 *
 * This module owns the capture → crop → bytes path only. Its HTTP surface is
 * `nodeExportRoutes.ts`.
 */
import sharp from 'sharp'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { AgentCaptureNodeRectSchema } from '@core/studio-capture'
import { captureFrames } from '../../ai/mcp/capture/captureFrames'

/**
 * The per-frame entries a capture returns. `captureFrames` hands back an
 * `AiToolOutput` whose `data` is `unknown` by construction (it is a tool
 * payload, not a typed return), so it is validated here like any other
 * untyped boundary — the same posture `shareSnapshot.ts` takes over the same
 * payload.
 */
const CaptureFrameResultSchema = Type.Object({
  pageId: Type.String(),
  ok: Type.Boolean(),
  imageIndex: Type.Optional(Type.Number()),
  imageScale: Type.Optional(Type.Number()),
  nodeRects: Type.Optional(Type.Array(AgentCaptureNodeRectSchema)),
  error: Type.Optional(Type.String()),
})

const CaptureDataSchema = Type.Object({
  frames: Type.Array(CaptureFrameResultSchema),
})

/** A crop rectangle in IMAGE pixels, ready for `sharp().extract()`. */
export interface NodeCropBox {
  left: number
  top: number
  width: number
  height: number
}

export interface ResolveNodeCropBoxInput {
  /** The node's box in frame-local CSS pixels, straight off the capture's `nodeRects`. */
  rect: { x: number; y: number; width: number; height: number }
  /** Image pixels per CSS pixel, as REPORTED by the capture (never the requested dpr). */
  imageScale: number
  /** The captured PNG's real dimensions, in image pixels. */
  imageWidth: number
  imageHeight: number
}

export type ResolveNodeCropBoxResult =
  | { ok: true; box: NodeCropBox }
  | { ok: false; error: string }

/**
 * Turn a CSS-pixel node rect into an image-pixel crop box, clamped to the
 * captured image.
 *
 * Two things are deliberately NOT tolerated:
 *
 *   - A zero-area node. A `display: none` element, or one whose content has
 *     not laid out, reports a 0×0 rect; cropping to it would either throw
 *     inside the rasteriser or produce a 1×1 pixel the user would have to
 *     interpret. It is refused with a reason instead.
 *   - A rect that lies entirely outside the captured image. That means the
 *     node scrolled out of the frame the capture photographed, which is a
 *     real condition worth naming rather than silently returning the image's
 *     top-left corner.
 *
 * A rect that OVERLAPS the image is clamped, not refused: an element bleeding
 * a few pixels past the frame edge is ordinary, and the visible part is the
 * honest answer.
 */
export function resolveNodeCropBox(input: ResolveNodeCropBoxInput): ResolveNodeCropBoxResult {
  const { rect, imageScale, imageWidth, imageHeight } = input
  if (!(imageScale > 0) || !(imageWidth > 0) || !(imageHeight > 0)) {
    return { ok: false, error: 'The capture produced no usable image to crop.' }
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return {
      ok: false,
      error: 'This element measures 0×0 on the canvas (it is hidden or has no laid-out content), so there is nothing to export.',
    }
  }

  const left = Math.floor(rect.x * imageScale)
  const top = Math.floor(rect.y * imageScale)
  const right = Math.ceil((rect.x + rect.width) * imageScale)
  const bottom = Math.ceil((rect.y + rect.height) * imageScale)

  const clampedLeft = Math.min(Math.max(left, 0), imageWidth)
  const clampedTop = Math.min(Math.max(top, 0), imageHeight)
  const clampedRight = Math.min(Math.max(right, 0), imageWidth)
  const clampedBottom = Math.min(Math.max(bottom, 0), imageHeight)

  const width = clampedRight - clampedLeft
  const height = clampedBottom - clampedTop
  if (width <= 0 || height <= 0) {
    return {
      ok: false,
      error: 'This element sits outside the area the capture photographed, so it is not in the image to crop out.',
    }
  }

  return { ok: true, box: { left: clampedLeft, top: clampedTop, width, height } }
}

export interface ExportNodePngInput {
  /** The user the capture runs on behalf of — carried through to the live-bridge fallback. */
  userId: string
  dir: string
  pageId: string
  nodeId: string
  /** Requested pixel density; the capture pipeline may clamp it (see module doc). */
  scale: number
}

/** Injectable seams for tests — never passed by the route. Mirrors `ShareSnapshotOverrides`. */
export interface ExportNodePngOverrides {
  captureFrames?: typeof captureFrames
}

export type ExportNodePngResult =
  | { ok: true; png: Buffer; width: number; height: number; imageScale: number }
  | { ok: false; error: string }

/** Capture `pageId`, cut `nodeId` out of it, and return the PNG bytes. */
export async function exportNodePng(
  input: ExportNodePngInput,
  overrides: ExportNodePngOverrides = {},
): Promise<ExportNodePngResult> {
  const capture = overrides.captureFrames ?? captureFrames
  const outcome = await capture({
    userId: input.userId,
    dir: input.dir,
    pageIds: [input.pageId],
    dpr: input.scale,
    // The export is a picture of a design at a density, not a vision payload:
    // `measurement` is the purpose whose resolution cap exists to preserve
    // detail rather than to fit a model's context window.
    purpose: 'measurement',
  })
  if (!outcome.output.ok) {
    return { ok: false, error: outcome.output.error ?? 'This screen could not be photographed.' }
  }

  const parsed = safeParseValue(CaptureDataSchema, outcome.output.data ?? {})
  if (!parsed.ok) {
    return {
      ok: false,
      error: `The capture returned a result this server could not validate: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    }
  }

  const frame = parsed.value.frames.find((entry) => entry.pageId === input.pageId)
  if (!frame) return { ok: false, error: 'The capture returned no frame for this screen.' }
  if (!frame.ok || frame.imageIndex === undefined) {
    return { ok: false, error: frame.error ?? 'This screen could not be photographed.' }
  }

  const image = (outcome.output.images ?? [])[frame.imageIndex]
  if (!image) return { ok: false, error: 'The capture reported an image this server did not receive.' }

  const rect = frame.nodeRects?.find((entry) => entry.nodeId === input.nodeId)
  if (!rect) {
    return {
      ok: false,
      error: 'This element was not measured in the capture — it may not be rendered on this screen. Reload the board and try again.',
    }
  }

  const source = Buffer.from(image.data, 'base64')
  const meta = await sharp(source).metadata()
  const crop = resolveNodeCropBox({
    rect,
    imageScale: frame.imageScale ?? 1,
    imageWidth: meta.width ?? 0,
    imageHeight: meta.height ?? 0,
  })
  if (!crop.ok) return crop

  const png = await sharp(source).extract(crop.box).png().toBuffer()
  return {
    ok: true,
    png,
    width: crop.box.width,
    height: crop.box.height,
    imageScale: frame.imageScale ?? 1,
  }
}
