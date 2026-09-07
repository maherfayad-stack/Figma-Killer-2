/**
 * The prototype player, on a component that has interactions of its own.
 *
 * Two rules, and the bug was that neither held:
 *
 *   1. **Both fire.** A live frame is the page as a visitor gets it, so the
 *      authored component's own `onClick` runs — the canvas used to swallow the
 *      click in the CAPTURE phase, above the component, so a linked button gave
 *      you the link or the component's behaviour, never both.
 *   2. **The FIRST press follows the link.** A `click` is dispatched at the
 *      nearest common ancestor of the mousedown and mouseup targets, and when
 *      the mousedown target has left the document by the time the button comes
 *      up there is no common ancestor and the browser dispatches NO CLICK AT
 *      ALL. A component whose hover/press effect re-renders under the finger
 *      does exactly that on the first press and settles by the second — which
 *      is what "doesn't work on first click" looks like from the outside. The
 *      player therefore reads the press/release pair on the node's own host
 *      element, which `NodeRenderer` owns and no component can replace.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { registry } from '@core/module-engine'
import type { ModuleComponentProps, ModuleDefinition } from '@core/module-engine'
import { captureNodeHint } from '@core/studio-anchor'
import type { PrototypeLink } from '@core/studio-prototype'
import { waitForCanvasElement } from './iframeCanvasQuery'
import '@modules/base'

let componentClicks = 0

/**
 * Stands in for a design-system / package component: the editor's bag goes on a
 * `display: contents` HOST, and the component's own interactive element is a
 * DESCENDANT of it — exactly the shape `@modules/alm/register.tsx` and
 * `registerProjectModules.ts` both build.
 */
const FancyEditor: React.FC<ModuleComponentProps<Record<string, unknown>>> = ({ nodeWrapperProps }) => {
  const { style: _style, ...editorProps } = (nodeWrapperProps ?? {}) as Record<string, unknown>
  return React.createElement(
    'div',
    { ...editorProps, style: { display: 'contents' } },
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'fancy-inner',
        onClick: () => {
          componentClicks += 1
        },
      },
      'Back',
    ),
  )
}

registry.registerOrReplace({
  id: 'test.fancy',
  name: 'Fancy',
  description: 'A component with interactions of its own',
  category: 'Test',
  version: '1.0.0',
  trusted: true,
  schema: {},
  defaults: {},
  component: FancyEditor,
  render: () => ({ html: '' }),
} as unknown as ModuleDefinition<Record<string, unknown>>)

function renderCanvas() {
  return render(
    <DndContext>
      <CanvasRoot />
    </DndContext>,
  )
}

const state = () => useEditorStore.getState()

/** A live, armed player sitting one screen deep, with a `back` link on `nodeId`. */
function armPlayerOneScreenDeep(homePageId: string, screenPageId: string, nodeId: string) {
  const page = state().site!.pages.find((candidate) => candidate.id === screenPageId)!
  const link: PrototypeLink = {
    id: 'back-link',
    source: { pageId: screenPageId, node: captureNodeHint(page, nodeId)! },
    trigger: 'click',
    action: 'back',
    targetPageId: null,
  }
  useEditorStore.setState({
    canvasView: 'live',
    activePageId: homePageId,
    playMode: true,
    playState: { screens: [{ pageId: screenPageId, transition: 'slide-left' }], overlays: [] },
    playTransition: 'slide-left',
    prototype: { version: 1, links: [link] },
  })
}

beforeEach(() => {
  cleanup()
  componentClicks = 0
  useEditorStore.setState({
    site: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activePageId: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    playMode: false,
    playState: { screens: [], overlays: [] },
    playTransition: null,
    playLeaveTransition: null,
    prototype: { version: 1, links: [] },
  })
})

describe('prototype player — a link on a component that has its own interactions', () => {
  it('runs the component OWN click handler as well as the link', async () => {
    const site = state().createSite('Both')
    const home = site.pages[0]!
    const second = state().addPage('Second', 'second')
    const backId = state().insertNode('test.fancy', {}, second.rootNodeId)
    armPlayerOneScreenDeep(home.id, second.id, backId)

    renderCanvas()
    const inner = await waitForCanvasElement<HTMLButtonElement>('[data-testid="fancy-inner"]')

    await act(async () => {
      fireEvent.pointerDown(inner)
      fireEvent.mouseDown(inner)
      fireEvent.pointerUp(inner)
      fireEvent.mouseUp(inner)
      fireEvent.click(inner)
    })

    expect(state().playState.screens.length).toBe(0)
    expect(componentClicks).toBe(1)
  })

  it('follows the link on a press/release that the browser never turns into a click', async () => {
    const site = state().createSite('First Click')
    const home = site.pages[0]!
    const second = state().addPage('Second', 'second')
    const backId = state().insertNode('test.fancy', {}, second.rootNodeId)
    armPlayerOneScreenDeep(home.id, second.id, backId)

    renderCanvas()
    const inner = await waitForCanvasElement<HTMLButtonElement>('[data-testid="fancy-inner"]')

    // The component re-renders under the finger and its pressed element leaves
    // the document, so no `click` is dispatched anywhere. This is the FIRST
    // press on a component with a hover/press effect, in full.
    await act(async () => {
      fireEvent.pointerDown(inner)
      fireEvent.mouseDown(inner)
      fireEvent.pointerUp(inner)
    })

    expect(state().playState.screens.length).toBe(0)
  })

  it('follows exactly once when the press and the click both land', async () => {
    const site = state().createSite('Once')
    const home = site.pages[0]!
    const second = state().addPage('Second', 'second')
    const backId = state().insertNode('test.fancy', {}, second.rootNodeId)
    armPlayerOneScreenDeep(home.id, second.id, backId)

    let follows = 0
    const realFollow = state().followPrototypeLink
    useEditorStore.setState({
      followPrototypeLink: ((link: Parameters<typeof realFollow>[0]) => {
        follows += 1
        return realFollow(link)
      }) as typeof realFollow,
    })

    renderCanvas()
    const inner = await waitForCanvasElement<HTMLButtonElement>('[data-testid="fancy-inner"]')

    await act(async () => {
      fireEvent.pointerDown(inner)
      fireEvent.pointerUp(inner)
      fireEvent.click(inner)
    })

    useEditorStore.setState({ followPrototypeLink: realFollow })
    expect(follows).toBe(1)
    expect(state().playState.screens.length).toBe(0)
  })

  it('navigates forward and back through the full flow', async () => {
    const site = state().createSite('Flow')
    const home = site.pages[0]!
    const goId = state().insertNode('test.fancy', {}, home.rootNodeId)
    const second = state().addPage('Second', 'second')
    const backId = state().insertNode('test.fancy', {}, second.rootNodeId)

    const pages = state().site!.pages
    const homePage = pages.find((p) => p.id === home.id)!
    const secondPage = pages.find((p) => p.id === second.id)!
    useEditorStore.setState({
      canvasView: 'live',
      activePageId: home.id,
      playMode: true,
      playState: { screens: [], overlays: [] },
      prototype: {
        version: 1,
        links: [
          {
            id: 'go',
            source: { pageId: home.id, node: captureNodeHint(homePage, goId)! },
            trigger: 'click',
            action: 'navigate',
            targetPageId: second.id,
            transition: 'slide-left',
          },
          {
            id: 'back',
            source: { pageId: second.id, node: captureNodeHint(secondPage, backId)! },
            trigger: 'click',
            action: 'back',
            targetPageId: null,
          },
        ],
      },
    })

    renderCanvas()
    const goEl = await waitForCanvasElement<HTMLButtonElement>(
      `[data-node-id="${goId}"] [data-testid="fancy-inner"]`,
    )
    await act(async () => {
      fireEvent.pointerDown(goEl)
      fireEvent.pointerUp(goEl)
      fireEvent.click(goEl)
    })
    expect(state().playState.screens.map((entry) => entry.pageId)).toEqual([second.id])

    const backEl = await waitForCanvasElement<HTMLButtonElement>(
      `[data-node-id="${backId}"] [data-testid="fancy-inner"]`,
    )
    await act(async () => {
      fireEvent.pointerDown(backEl)
      fireEvent.pointerUp(backEl)
      fireEvent.click(backEl)
    })
    expect(state().playState.screens.length).toBe(0)
  })

  it('leaves the editor hover ring alone while the player is armed', async () => {
    const site = state().createSite('Hover')
    const home = site.pages[0]!
    const second = state().addPage('Second', 'second')
    const backId = state().insertNode('test.fancy', {}, second.rootNodeId)
    armPlayerOneScreenDeep(home.id, second.id, backId)

    renderCanvas()
    const inner = await waitForCanvasElement<HTMLButtonElement>('[data-testid="fancy-inner"]')

    await act(async () => {
      fireEvent.mouseEnter(inner)
    })
    expect(state().hoveredNodeId).toBeNull()
  })
})
