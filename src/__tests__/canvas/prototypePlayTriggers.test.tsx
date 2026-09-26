/**
 * The four prototype triggers that are not a click, end to end through the
 * canvas — the layer where each one is actually delivered.
 *
 * `linkForTrigger`, `linkForKey`, `delayTriggersForScreen` and
 * `releaseActionFor` are unit-tested in `@core/studio-prototype`. What cannot be
 * tested there is the part that has historically been wrong (`proto-back`): WHICH
 * canvas event each trigger rides, and whether it reaches the machine at all.
 *
 *   - `hover` rides `onMouseEnter`, in the one branch of `onNodeHover` an armed
 *     player does not stand down.
 *   - `press` rides `onPointerDownCapture` — the DOWN, not the release, which is
 *     the whole difference from a click — and its reverse rides the release.
 *   - `key` rides a parent-document listener, because a keystroke has no element
 *     under it.
 *   - `after-delay` rides no event at all: arriving on the screen is the trigger.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { getCanvasHover } from '@site/canvas/canvasHover'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { registry } from '@core/module-engine'
import type { ModuleComponentProps, ModuleDefinition } from '@core/module-engine'
import { captureNodeHint } from '@core/studio-anchor'
import type { PrototypeLink, PrototypeTrigger } from '@core/studio-prototype'
import { waitForCanvasElement } from './iframeCanvasQuery'
import '@modules/base'

const Plain: React.FC<ModuleComponentProps<Record<string, unknown>>> = ({ nodeWrapperProps }) =>
  React.createElement('div', { ...nodeWrapperProps, 'data-testid': 'trigger-target' }, 'Target')

registry.registerOrReplace({
  id: 'test.trigger-target',
  name: 'Target',
  description: 'A node a prototype link starts from',
  category: 'Test',
  version: '1.0.0',
  trusted: true,
  schema: {},
  defaults: {},
  component: Plain,
  render: () => ({ html: '' }),
} as unknown as ModuleDefinition<Record<string, unknown>>)

const state = () => useEditorStore.getState()

function renderCanvas() {
  return render(
    <DndContext>
      <CanvasRoot />
    </DndContext>,
  )
}

/**
 * A two-page site with one link from the home page's node, armed and live.
 * Returns the node id so the test can find the element it starts from.
 */
function armed(
  trigger: PrototypeTrigger,
  overrides: Partial<PrototypeLink> = {},
): { homeId: string; secondId: string; nodeId: string } {
  const site = state().createSite('Triggers')
  const home = site.pages[0]!
  // The node goes in BEFORE the second page exists: `insertNode` writes to the
  // ACTIVE tree, and `addPage` makes the page it created active.
  const nodeId = state().insertNode('test.trigger-target', {}, home.rootNodeId)
  const second = state().addPage('Second', 'second')
  const homePage = state().site!.pages.find((page) => page.id === home.id)!

  const link: PrototypeLink = {
    id: 'link-1',
    source: { pageId: home.id, node: captureNodeHint(homePage, nodeId)! },
    trigger,
    action: 'navigate',
    targetPageId: second.id,
    transition: 'slide-left',
    ...overrides,
  }

  useEditorStore.setState({
    canvasView: 'live',
    activePageId: home.id,
    playMode: true,
    playState: { screens: [], overlays: [] },
    prototype: { version: 1, links: [link] },
  })
  return { homeId: home.id, secondId: second.id, nodeId }
}

const screens = () => state().playState.screens.map((entry) => entry.pageId)

beforeEach(() => {
  cleanup()
  useEditorStore.setState({
    site: null,
    selectedNodeId: null,
    selectedNodeIds: [],
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

describe('the hover trigger', () => {
  it('follows on the pointer arriving, and still lights no editor hover ring', async () => {
    const { secondId } = armed({ kind: 'hover' })
    renderCanvas()
    const target = await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.mouseEnter(target)
    })

    expect(screens()).toEqual([secondId])
    // The ring is editing chrome, and a visitor should see the component's own
    // hover state and nothing of ours.
    expect(getCanvasHover()).toBeNull()
  })

  it('does not follow on the way out — one pass is one navigation', async () => {
    armed({ kind: 'hover' })
    renderCanvas()
    const target = await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.mouseLeave(target)
    })

    expect(screens()).toEqual([])
  })

  it('is not followed by a click — the triggers are matched exactly', async () => {
    armed({ kind: 'hover' })
    renderCanvas()
    const target = await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.pointerDown(target)
      fireEvent.pointerUp(target)
      fireEvent.click(target)
    })

    expect(screens()).toEqual([])
  })
})

describe('the press trigger', () => {
  it('follows on the way DOWN, not on the release', async () => {
    const { secondId } = armed({ kind: 'press', reverseOnRelease: false })
    renderCanvas()
    const target = await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.pointerDown(target)
    })
    expect(screens()).toEqual([secondId])

    await act(async () => {
      fireEvent.pointerUp(target)
      fireEvent.click(target)
    })
    // `reverseOnRelease: false` — the press was a one-way trip.
    expect(screens()).toEqual([secondId])
  })

  it('comes back on release when it was asked to', async () => {
    const { secondId } = armed({ kind: 'press', reverseOnRelease: true })
    renderCanvas()
    const target = await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.pointerDown(target)
    })
    expect(screens()).toEqual([secondId])

    await act(async () => {
      fireEvent.pointerUp(target)
    })
    expect(screens()).toEqual([])
  })
})

describe('the key trigger', () => {
  it('follows a keystroke with no element under it', async () => {
    const { secondId } = armed({ kind: 'key', key: 'k' })
    renderCanvas()
    await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    // Case-insensitive: `KeyboardEvent.key` reports the SHIFTED character, and
    // a link authored on `k` is not a different link with caps lock on.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'K' })
    })

    expect(screens()).toEqual([secondId])
  })

  it('stands down for a modifier — that is an editor shortcut, not a trigger', async () => {
    armed({ kind: 'key', key: 'k' })
    renderCanvas()
    await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    })

    expect(screens()).toEqual([])
  })
})

describe('the after-delay trigger', () => {
  it('follows itself once the screen has been showing long enough', async () => {
    const { secondId } = armed({ kind: 'after-delay', ms: 10 })
    renderCanvas()
    await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    // Deliberately no "not yet" assertion here: mounting the frame takes longer
    // than any delay short enough to wait on, so the only honest thing this
    // test can assert is that nobody touched anything and the screen changed.
    // The "it does not fire" half is the cancellation case below.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(screens()).toEqual([secondId])
  })

  it('is cancelled by disarming the player, not left running', async () => {
    armed({ kind: 'after-delay', ms: 30 })
    renderCanvas()
    await waitForCanvasElement<HTMLElement>('[data-testid="trigger-target"]')

    await act(async () => {
      state().setPlayMode(false)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })

    expect(screens()).toEqual([])
  })
})
