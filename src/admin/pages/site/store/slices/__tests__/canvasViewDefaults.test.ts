/**
 * What switching canvas view does BESIDES switching canvas view, and which
 * viewport a project opens on.
 *
 * Both rules exist because of the same failure: a piece of session state that
 * only one view can see, left set when you leave that view. `playMode` armed on
 * the board routed every click to the player, with no Play button drawn there
 * to turn it off — selection was dead until a page reload.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { Breakpoint } from '@core/page-tree'
import { resolveProjectDefaultBreakpointId } from '../projectDefaultViewport'

function breakpoint(id: string, width: number, icon: string): Breakpoint {
  return { id, label: id, width, icon } as Breakpoint
}

const VIEWPORTS = [
  breakpoint('mobile', 375, 'smartphone'),
  breakpoint('tablet', 768, 'tablet'),
  breakpoint('desktop', 1440, 'monitor'),
]

describe('canvas view arms and disarms the player', () => {
  beforeEach(() => {
    useEditorStore.setState({ canvasView: 'design', playMode: false, runScripts: false })
  })

  it('arms the player and the site scripts on the way into live', () => {
    useEditorStore.getState().setCanvasView('live')
    expect(useEditorStore.getState().playMode).toBe(true)
    expect(useEditorStore.getState().runScripts).toBe(true)
  })

  it('disarms the player on the way out, so the board can be clicked again', () => {
    useEditorStore.getState().setCanvasView('live')
    useEditorStore.getState().setCanvasView('design')
    expect(useEditorStore.getState().playMode).toBe(false)
  })

  it('leaves the scripts running when you go back to the board', () => {
    // Orthogonal to the view by design — it applies to both — so leaving live
    // must not silently undo a toggle the author can still see and use.
    useEditorStore.getState().setCanvasView('live')
    useEditorStore.getState().setCanvasView('design')
    expect(useEditorStore.getState().runScripts).toBe(true)
  })
})

describe('the viewport a project opens on', () => {
  it('opens a phone-shaped project on its phone viewport', () => {
    expect(resolveProjectDefaultBreakpointId(VIEWPORTS, 393)).toBe('mobile')
  })

  it('leaves a desktop-shaped project where it already was', () => {
    expect(resolveProjectDefaultBreakpointId(VIEWPORTS, 1440)).toBeNull()
  })

  it('says nothing when the project records no frame width', () => {
    expect(resolveProjectDefaultBreakpointId(VIEWPORTS, undefined)).toBeNull()
  })

  it('says nothing when the site has no viewport of that shape to offer', () => {
    const desktopOnly = [breakpoint('desktop', 1440, 'monitor')]
    expect(resolveProjectDefaultBreakpointId(desktopOnly, 393)).toBeNull()
  })

  it('picks a phone viewport by its icon, whatever its width', () => {
    // `icon` is the explicit answer and outranks the width — a project at 393
    // opens on a 430px viewport that calls itself a phone.
    const wide = [breakpoint('handset', 430, 'smartphone'), breakpoint('desktop', 1440, 'monitor')]
    expect(resolveProjectDefaultBreakpointId(wide, 393)).toBe('handset')
  })
})
