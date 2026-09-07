/**
 * Headless agent capture — screenshot Studio board frames with no editor tab
 * open, and without touching one that is.
 *
 * ## Why this needs no `studio.run.project` gate
 *
 * `referenceRender.ts` is Tier 2 and gated, because it boots the PROJECT'S OWN
 * dev server: `scripts.dev` runs, every dependency it imports executes, and
 * the blast radius is the whole repo's code. That gate is correct and stays.
 *
 * This path executes none of that. `/admin/agent-capture` renders exactly what
 * the canvas renders — Studio's OWN parse output, the `Page` trees the bounded
 * static evaluator already produced by READING the AST, drawn by Studio's own
 * module renderers into Studio's own iframe surface. No component from the
 * user's project is invoked, no hook is called, no `import` of project code is
 * evaluated; the only project-authored bytes involved are CSS text and image
 * files, both inert. Parse-never-execute holds here exactly as it holds in the
 * live canvas, so this needs precisely the capability the live canvas path
 * already needs (`studio.write`) and nothing more. Gating it at Tier 2 would
 * be security theatre: it would make the SAFE path harder to reach than the
 * live-tab path that renders the identical DOM.
 *
 * ## What it does, and what it deliberately does not
 *
 * Opening the page, settling it and validating its readiness report is
 * `captureSession.ts`'s job — shared with the inspect driver so the grant, the
 * ready expression and the failure vocabulary have one owner. What is left
 * here is the part that is genuinely about PHOTOGRAPHY: choosing the render
 * density, rasterising each frame element, and clamping the result.
 *
 * It never touches the user's open tab. No pan, no zoom, no active-page
 * change, no cleared selection — the three things the live-bridge path has to
 * do to a shared session in order to photograph a frame, and the reason a
 * capture used to be visible to whoever was editing at the time.
 *
 * ## Resolution
 *
 * `dpr` is applied as Chromium's `deviceScaleFactor`, so the frame is RENDERED
 * at that density rather than rasterised at 1x and scaled. The cap that
 * applies (`@core/ai`'s `effectiveCaptureRatio`) is the same one the live path
 * applies, computed first from the authored frame geometry — which the driver
 * already knows from `.studio/boards.json` before it navigates — and then
 * re-checked against the REAL captured bytes, because a scroll-unrolled page
 * can end up taller than its authored height. A capture that overshoots on
 * the second check is downscaled, and `imageScale` is derived from the actual
 * pixel width either way. A `studio_compare` verdict therefore does not depend
 * on which of the two rasterisers produced the bytes.
 */
import sharp from 'sharp'
import { aiToolOk, effectiveCaptureRatio, type AiToolImage, type AiToolOutput, type CapturePurpose } from '@core/ai'
import type { PreviewAxes } from '@core/studio-board'
import { AGENT_CAPTURE_FRAME_ATTR, type AgentCaptureFrameReport } from '@core/studio-capture'
import type { CapturePage } from './browserPool'
import {
  authoredGeometry,
  captureViewport,
  withSettledCapture,
  type HeadlessCaptureFailure,
  type HeadlessCaptureOverrides,
} from './captureSession'

// Re-exported so `captureFrames.ts` and the tools keep one import site for the
// whole headless vocabulary, wherever a given piece happens to be defined.
export type {
  HeadlessCaptureFailure,
  HeadlessCaptureFailureCode,
  HeadlessCaptureOverrides,
} from './captureSession'

export interface HeadlessCaptureInput {
  userId: string
  dir: string
  pageIds: readonly string[]
  dpr?: number
  purpose?: CapturePurpose
  axes?: Partial<PreviewAxes>
}

export type HeadlessCaptureResult = { ok: true; output: AiToolOutput } | HeadlessCaptureFailure

/**
 * Bring one frame's PNG within the cap that actually applies to the REAL
 * captured size. The authored-geometry pre-clamp is usually exact; this only
 * bites when the rendered frame turned out taller than its authored height
 * (scroll-unroll), which the driver cannot know before it navigates.
 */
async function clampCapturedPng(
  png: Buffer,
  cssWidth: number,
  cssHeight: number,
  requestedRatio: number,
  purpose: CapturePurpose,
): Promise<{ png: Buffer; width: number; height: number }> {
  const meta = await sharp(png).metadata()
  const width = meta.width ?? Math.round(cssWidth * requestedRatio)
  const height = meta.height ?? Math.round(cssHeight * requestedRatio)
  const actualRatio = cssWidth > 0 ? width / cssWidth : 1
  const allowedRatio = effectiveCaptureRatio(cssWidth, cssHeight, actualRatio, purpose)
  if (allowedRatio >= actualRatio) return { png, width, height }

  const targetWidth = Math.max(1, Math.round(cssWidth * allowedRatio))
  const resized = await sharp(png).resize({ width: targetWidth }).png().toBuffer()
  const resizedMeta = await sharp(resized).metadata()
  return {
    png: resized,
    width: resizedMeta.width ?? targetWidth,
    height: resizedMeta.height ?? Math.round(cssHeight * allowedRatio),
  }
}

/**
 * Capture `pageIds` from `dir` headlessly, returning the SAME
 * `{ frames[], images[] }` shape `studio_export_frames` returns from the live
 * bridge — so `studio_screenshot` and `studio_compare` consume either source
 * without branching on which one answered.
 */
export async function captureFramesHeadless(
  input: HeadlessCaptureInput,
  overrides: HeadlessCaptureOverrides = {},
): Promise<HeadlessCaptureResult> {
  const purpose: CapturePurpose = input.purpose ?? 'vision'
  const geometry = authoredGeometry(input.dir, input.pageIds)

  // The density to RENDER at: the requested dpr, pre-clamped by what the
  // authored geometry already proves is allowed. Re-checked against the real
  // bytes in `clampCapturedPng`.
  let renderRatio = input.dpr && input.dpr > 0 ? input.dpr : 1
  for (const frame of geometry.values()) {
    renderRatio = Math.min(renderRatio, effectiveCaptureRatio(frame.width, frame.height, renderRatio, purpose))
  }

  const session = await withSettledCapture(
    {
      userId: input.userId,
      dir: input.dir,
      pageIds: input.pageIds,
      ...(input.axes ? { axes: input.axes } : {}),
      viewport: captureViewport(geometry),
      deviceScaleFactor: renderRatio,
    },
    overrides,
    (page, frames) => rasteriseFrames(page, frames, purpose, renderRatio),
  )
  return session.ok ? { ok: true, output: session.value } : session
}

async function rasteriseFrames(
  page: CapturePage,
  reports: readonly AgentCaptureFrameReport[],
  purpose: CapturePurpose,
  renderRatio: number,
): Promise<AiToolOutput> {
  const images: AiToolImage[] = []
  const frames: Array<Record<string, unknown>> = []
  for (const frame of reports) {
    if (!frame.ok) {
      frames.push({ pageId: frame.pageId, ok: false, error: frame.error })
      continue
    }
    const selector = `[${AGENT_CAPTURE_FRAME_ATTR}="${cssAttrEscape(frame.pageId)}"]`
    const element = await page.$(selector)
    if (!element) {
      frames.push({ pageId: frame.pageId, ok: false, error: `The capture page reported "${frame.pageId}" ready but rendered no element for it.` })
      continue
    }
    let shot: Buffer
    try {
      shot = await element.screenshot({ type: 'png' })
    } catch (err) {
      frames.push({
        pageId: frame.pageId,
        ok: false,
        error: `Rasterising "${frame.pageId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    const clamped = await clampCapturedPng(shot, frame.cssWidth, frame.cssHeight, renderRatio, purpose)
    const imageIndex = images.length
    images.push({ mimeType: 'image/png', data: clamped.png.toString('base64') })
    frames.push({
      pageId: frame.pageId,
      ok: true,
      width: clamped.width,
      height: clamped.height,
      imageIndex,
      nodeRects: frame.nodeRects,
      // Derived from the REAL captured width, never from the requested dpr —
      // the same rule the live path follows, for the same reason.
      imageScale: frame.cssWidth > 0 ? clamped.width / frame.cssWidth : 1,
      warnings: frame.warnings,
    })
  }

  return aiToolOk({ frames, source: 'headless' }, images)
}

/** Escapes a page id for use inside a CSS attribute selector's double-quoted value. */
function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
