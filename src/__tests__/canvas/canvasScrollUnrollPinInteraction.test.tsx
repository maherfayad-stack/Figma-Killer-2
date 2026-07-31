/**
 * Regression test for the ONE place `useIframeFrameAutoHeight` (the body-
 * height PIN, so `%` chains resolve) and `CanvasScrollUnrollInjector` (the
 * scroll UNROLL, so clipped regions grow) can fight — per the WS-8.2 work
 * order: "Write a regression test for the pin/unroll interaction
 * specifically — this is the single place these two systems can deadlock or
 * oscillate, and it will not be caught by testing either in isolation."
 *
 * The failure mode this guards against: an earlier draft of the unroll
 * stylesheet forced `body, html { height: auto !important }`. Since
 * `!important` beats a plain (non-`!important`) inline style regardless of
 * origin, that would have WON over `useIframeFrameAutoHeight`'s own
 * `body.style.height = '<fitted>px'` pin — collapsing the percentage basis
 * every imported `html, body, #root { height: 100% }` shell depends on. The
 * fix (documented at length in `canvasScrollUnroll.ts` →
 * `buildScrollUnrollRules`) is that the unroll stylesheet never declares a
 * bare `height` on `body`/`html`, and the JS tagging pass only ever walks
 * `body`'s DESCENDANTS (`body.querySelectorAll('*')` cannot select `body` or
 * `html` themselves) — so the pin and the unroll never write to the same
 * property on the same element.
 *
 * This test renders a REAL design frame (both injectors mount together
 * through `IframeFrameSurface`, exactly as in the editor) and asserts the pin
 * survives a mutation that ALSO triggers the unroll's tagging pass —
 * happy-dom has no real layout engine, so this can't assert exact pixel
 * growth, but it can assert the one invariant that actually matters: body's
 * height stays a DEFINITE pinned value, never `auto`, through the whole
 * sequence, and the frame settles (test completion itself is evidence
 * against an infinite oscillation loop between the two observers).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { CanvasTransformLayer } from '@site/canvas/CanvasTransformLayer'
import { DEFAULT_BREAKPOINTS } from '@core/page-tree'
import { CANVAS_VIEWPORT_HEIGHT } from '@site/canvas/resolveViewportUnits'
import { SCROLL_UNROLL_ATTR } from '@site/canvas/canvasScrollUnroll'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import { CANVAS_FRAME_READY_TIMEOUT_MS, waitForCanvasFrameDocument } from './iframeCanvasQuery'
import '@modules/base'

const ANIMATION_STYLE_TAG_ID = 'studio-canvas-animation'
const UNROLL_STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

function expectDefinitePinnedHeight(doc: Document): void {
  const height = doc.body.style.height
  expect(height).not.toBe('')
  expect(height).not.toBe('auto')
  const px = parseFloat(height)
  expect(Number.isFinite(px)).toBe(true)
  // Never below the viewport floor, and nowhere near the pathological
  // ceiling (resolveFrameFitHeight.MAX_FRAME_FIT_HEIGHT) an oscillation or a
  // runaway pin/unroll fight would drive it toward.
  expect(px).toBeGreaterThanOrEqual(CANVAS_VIEWPORT_HEIGHT)
  expect(px).toBeLessThan(CANVAS_VIEWPORT_HEIGHT * 10)
}

beforeEach(() => {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['headline'] }),
      headline: makeNode({
        id: 'headline',
        moduleId: 'base.text',
        props: { text: 'Frame headline', tag: 'h1' },
      }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    runScripts: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('pin ⇄ unroll interaction', () => {
  it('both injectors mount on the same design frame', async () => {
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    const doc = await waitForCanvasFrameDocument('desktop')
    await waitFor(
      () => {
        expect(doc.getElementById(ANIMATION_STYLE_TAG_ID)).not.toBeNull()
        expect(doc.getElementById(UNROLL_STYLE_TAG_ID)).not.toBeNull()
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )
  })

  it('the body pin stays a definite px value once the frame settles', async () => {
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    const doc = await waitForCanvasFrameDocument('desktop')
    await waitFor(
      () => {
        expect(doc.getElementById(UNROLL_STYLE_TAG_ID)).not.toBeNull()
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    await waitFor(() => {
      expectDefinitePinnedHeight(doc)
    })
  })

  it('a mutation that triggers unroll tagging does not collapse the body pin', async () => {
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    const doc = await waitForCanvasFrameDocument('desktop')
    await waitFor(
      () => {
        expect(doc.getElementById(UNROLL_STYLE_TAG_ID)).not.toBeNull()
        expectDefinitePinnedHeight(doc)
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    // Insert a clipping, position:fixed panel directly — a mutation that
    // BOTH useIframeFrameAutoHeight's own MutationObserver (resets and
    // re-fits the pin on any body/head childList change) and
    // CanvasScrollUnrollInjector's tagging pass react to on the SAME event.
    const nav = doc.createElement('div')
    nav.style.position = 'fixed'
    doc.body.appendChild(nav)

    try {
      await waitFor(
        () => {
          expect(nav.getAttribute(SCROLL_UNROLL_ATTR)).toBe('fixed')
        },
        { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
      )

      // The pin survived the SAME settle that just tagged an element —
      // neither system clobbered the other's property.
      expectDefinitePinnedHeight(doc)
    } finally {
      nav.remove()
    }
  })

  it('a mutation that triggers explicit-height tagging does not collapse the body pin', async () => {
    // Complements the position:fixed mutation test above — every OTHER test
    // in this file only exercises that case. This is the eSIM
    // manual-entry-sheet shape: an element whose content clips (scrollHeight
    // > clientHeight) and is NOT position:fixed, so it gets tagged
    // 'explicit-height' instead of 'fixed' — a different branch of the same
    // injector, worth its own regression coverage of the pin surviving it.
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    const doc = await waitForCanvasFrameDocument('desktop')
    await waitFor(
      () => {
        expect(doc.getElementById(UNROLL_STYLE_TAG_ID)).not.toBeNull()
        expectDefinitePinnedHeight(doc)
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    // happy-dom has no layout engine, so scrollHeight/clientHeight default to
    // 0 (equal) on a freshly-created element — stub them to model a clipping
    // panel the same way canvasScrollUnrollInjector.test.tsx does.
    const panel = doc.createElement('div')
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(panel, 'clientHeight', { value: 500, configurable: true })
    doc.body.appendChild(panel)

    try {
      await waitFor(
        () => {
          expect(panel.getAttribute(SCROLL_UNROLL_ATTR)).toBe('explicit-height')
        },
        { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
      )

      // The pin survived the SAME settle that just tagged an element —
      // neither system clobbered the other's property.
      expectDefinitePinnedHeight(doc)
    } finally {
      panel.remove()
    }
  })

  it('the unroll stylesheet never declares a bare height on body or html', async () => {
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    const doc = await waitForCanvasFrameDocument('desktop')
    await waitFor(
      () => {
        expect(doc.getElementById(UNROLL_STYLE_TAG_ID)).not.toBeNull()
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    const css = doc.getElementById(UNROLL_STYLE_TAG_ID)?.textContent ?? ''
    const universalRuleOnly = css.slice(0, css.indexOf(`[${SCROLL_UNROLL_ATTR}`))
    const bareHeightDeclarations = universalRuleOnly
      .split('\n')
      .filter((line) => /^\s*height\s*:/.test(line))
    expect(bareHeightDeclarations).toHaveLength(0)
  })
})
