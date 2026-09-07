/**
 * nodeExportCapture — the crop that turns a page capture into a node PNG.
 *
 * The maths is small and entirely load-bearing: get it wrong and the user
 * gets a picture of the wrong element with no error to tell them. So the
 * rounding, the clamping, and the two refusals are pinned here, and the
 * capture → crop wiring is exercised through the injectable `captureFrames`
 * seam so no Chromium is involved.
 */
import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { aiToolError, aiToolOk } from '@core/ai'
import { exportNodePng, resolveNodeCropBox } from './nodeExportCapture'

describe('resolveNodeCropBox', () => {
  it('scales a CSS-pixel rect into image pixels', () => {
    const result = resolveNodeCropBox({
      rect: { x: 10, y: 20, width: 100, height: 50 },
      imageScale: 2,
      imageWidth: 800,
      imageHeight: 600,
    })
    expect(result).toEqual({ ok: true, box: { left: 20, top: 40, width: 200, height: 100 } })
  })

  it('rounds outward so a fractional rect never clips the element', () => {
    // Floor the origin, ceil the far edge: half a pixel of neighbouring
    // background is a far better outcome than half a pixel of the element
    // sliced off.
    const result = resolveNodeCropBox({
      rect: { x: 10.4, y: 20.6, width: 100.3, height: 50.2 },
      imageScale: 1,
      imageWidth: 800,
      imageHeight: 600,
    })
    // x: floor(10.4)=10 … ceil(110.7)=111 ⇒ 101 wide.
    // y: floor(20.6)=20 … ceil(70.8)=71  ⇒ 51 tall.
    expect(result).toEqual({ ok: true, box: { left: 10, top: 20, width: 101, height: 51 } })
  })

  it('clamps a rect that bleeds past the image edge instead of refusing it', () => {
    // An element overhanging the frame edge is ordinary; the visible part is
    // the honest answer.
    const result = resolveNodeCropBox({
      rect: { x: 700, y: 550, width: 200, height: 200 },
      imageScale: 1,
      imageWidth: 800,
      imageHeight: 600,
    })
    expect(result).toEqual({ ok: true, box: { left: 700, top: 550, width: 100, height: 50 } })
  })

  it('refuses a zero-area element by name', () => {
    const result = resolveNodeCropBox({
      rect: { x: 10, y: 10, width: 0, height: 0 },
      imageScale: 1,
      imageWidth: 800,
      imageHeight: 600,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toContain('0×0')
  })

  it('refuses an element that lies entirely outside the capture', () => {
    const result = resolveNodeCropBox({
      rect: { x: 2_000, y: 2_000, width: 100, height: 100 },
      imageScale: 1,
      imageWidth: 800,
      imageHeight: 600,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toContain('outside the area the capture photographed')
  })

  it('refuses when the capture reported no usable image', () => {
    expect(
      resolveNodeCropBox({ rect: { x: 0, y: 0, width: 10, height: 10 }, imageScale: 0, imageWidth: 800, imageHeight: 600 }).ok,
    ).toBe(false)
    expect(
      resolveNodeCropBox({ rect: { x: 0, y: 0, width: 10, height: 10 }, imageScale: 1, imageWidth: 0, imageHeight: 0 }).ok,
    ).toBe(false)
  })
})

/** A solid PNG of the given size, base64-encoded the way a capture returns one. */
async function fakeCapturePng(width: number, height: number): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer()
  return png.toString('base64')
}

function captureStub(output: Awaited<ReturnType<typeof aiToolOk>>) {
  return async () => ({ source: 'headless' as const, output })
}

describe('exportNodePng', () => {
  const input = { userId: 'u1', dir: '/w/proj', pageId: 'pages/Home.tsx', nodeId: 'pages/Home.tsx:12:4', scale: 2 }

  it('cuts the node’s rect out of the captured frame at the capture’s own scale', async () => {
    const data = await fakeCapturePng(800, 600)
    const result = await exportNodePng(input, {
      captureFrames: captureStub(
        aiToolOk(
          {
            frames: [
              {
                pageId: 'pages/Home.tsx',
                ok: true,
                imageIndex: 0,
                // The capture clamped 2× down to 1.5× — the crop must follow
                // what it REPORTS, never the density that was requested.
                imageScale: 1.5,
                nodeRects: [{ nodeId: 'pages/Home.tsx:12:4', x: 100, y: 50, width: 200, height: 40 }],
              },
            ],
          },
          [{ mimeType: 'image/png', data }],
        ),
      ) as never,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.width).toBe(300)
    expect(result.height).toBe(60)
    expect(result.imageScale).toBe(1.5)
    const meta = await sharp(result.png).metadata()
    expect(meta.width).toBe(300)
    expect(meta.height).toBe(60)
  })

  it('reports the capture’s own failure rather than inventing one', async () => {
    const result = await exportNodePng(input, {
      captureFrames: captureStub(aiToolError('capture-unavailable: no Chromium')) as never,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('capture-unavailable')
  })

  it('says so when the node was not measured in the capture', async () => {
    const data = await fakeCapturePng(400, 300)
    const result = await exportNodePng(input, {
      captureFrames: captureStub(
        aiToolOk(
          { frames: [{ pageId: 'pages/Home.tsx', ok: true, imageIndex: 0, imageScale: 1, nodeRects: [] }] },
          [{ mimeType: 'image/png', data }],
        ),
      ) as never,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('not measured in the capture')
  })

  it('surfaces a per-frame capture failure', async () => {
    const result = await exportNodePng(input, {
      captureFrames: captureStub(
        aiToolOk({ frames: [{ pageId: 'pages/Home.tsx', ok: false, error: 'this screen would not settle' }] }),
      ) as never,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('this screen would not settle')
  })

  it('rejects a capture payload it cannot validate', async () => {
    const result = await exportNodePng(input, {
      captureFrames: captureStub(aiToolOk({ frames: 'not an array' })) as never,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('could not validate')
  })
})
