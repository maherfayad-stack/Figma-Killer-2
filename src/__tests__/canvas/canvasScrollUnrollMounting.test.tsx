/**
 * Scroll unrolling is scoped to DESIGN frames, exactly like
 * `CanvasAnimationInjector` (see `canvasAnimationInjectorMounting.test.tsx`
 * for the sibling contract this mirrors). Live mode is a visitor preview —
 * the app's own scroll clipping is exactly what a visitor would see — so the
 * live frame must NOT mount `CanvasScrollUnrollInjector` at all.
 *
 * Asserted through real renders rather than by reading the JSX, for the same
 * reason as the animation injector: `{!isLive && …}` is exactly the kind of
 * condition that survives a refactor while silently inverting.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { CanvasTransformLayer } from '@site/canvas/CanvasTransformLayer'
import { CanvasLiveSurface } from '@site/canvas/CanvasLiveSurface'
import { DEFAULT_BREAKPOINTS } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import { CANVAS_FRAME_READY_TIMEOUT_MS, waitForCanvasFrameDocument } from './iframeCanvasQuery'
import '@modules/base'

const STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

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

describe('CanvasScrollUnrollInjector mounting', () => {
  it('unrolls scroll regions in a design frame', async () => {
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
        expect(doc.getElementById(STYLE_TAG_ID)).not.toBeNull()
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    const css = doc.getElementById(STYLE_TAG_ID)?.textContent ?? ''
    expect(css).toContain('overflow: visible !important')
    expect(css).toContain('min-height: auto !important')
  })

  it('never mounts in a live frame', async () => {
    const page = useEditorStore.getState().site!.pages[0]
    const { container } = render(
      <CanvasLiveSurface
        page={page}
        activeBreakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
      />,
    )

    // The editor-chrome injector lands in every frame, design or live, so its
    // presence marks readiness without presuming anything about the injector
    // under test.
    let doc: Document | null = null
    await waitFor(
      () => {
        doc = container.querySelector('iframe')?.contentDocument ?? null
        expect(doc?.getElementById('studio-editor-chrome')).not.toBeNull()
      },
      { timeout: CANVAS_FRAME_READY_TIMEOUT_MS },
    )

    expect(doc!.getElementById(STYLE_TAG_ID)).toBeNull()
  })
})
