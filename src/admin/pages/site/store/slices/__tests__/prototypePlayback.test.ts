/**
 * The player, driven through the REAL editor store rather than the pure stack
 * machine underneath it.
 *
 * `playback.test.ts` already covers the machine, and it passed the whole time a
 * presented bottom sheet could not be dismissed in the browser: the bug was not
 * in the rules, it was in what survives a trip through the store's Mutative
 * draft. That is exactly the seam a pure-function test cannot see, so the
 * store-level behaviour gets its own.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { currentOverlay, currentScreen, type PrototypeLink } from '@core/studio-prototype'

function link(overrides: Partial<PrototypeLink> = {}): PrototypeLink {
  return {
    id: 'l1',
    origin: 'design',
    source: {
      pageId: 'sign-up',
      node: { nodeId: 'cta', indexPath: [0], moduleId: 'base.button', textSnippet: 'Continue' },
    },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'sms',
    transition: 'slide-left',
    ...overrides,
  }
}

const openSheet = link({ id: 'sheet', action: 'overlay', targetPageId: 'filters', transition: 'sheet' })

describe('the player, through the store', () => {
  beforeEach(() => {
    useEditorStore.getState().resetPlay()
  })

  it('pushes a screen and shows it', () => {
    useEditorStore.getState().followPrototypeLink(link())
    expect(currentScreen(useEditorStore.getState().playState, 'sign-up')).toBe('sms')
  })

  it('presents an overlay, takes it back off, and reports the presentation to play out', () => {
    const store = useEditorStore.getState()
    store.followPrototypeLink(openSheet)
    expect(currentOverlay(useEditorStore.getState().playState)).toBe('filters')

    const close = link({ action: 'close', targetPageId: null, transition: undefined })
    expect(store.followPrototypeLink(close)).toBe(true)
    expect(currentOverlay(useEditorStore.getState().playState)).toBeNull()
    // The exit animation needs to know it was a sheet, not a popup.
    expect(useEditorStore.getState().playLeaveTransition).toBe('sheet')
  })

  it('reports a close with nothing presented as the no-op it is', () => {
    expect(useEditorStore.getState().followPrototypeLink(
      link({ action: 'close', targetPageId: null, transition: undefined }),
    )).toBe(false)
  })

  it('goes back through an overlay before it pops the screen under it', () => {
    const store = useEditorStore.getState()
    store.followPrototypeLink(link())
    store.followPrototypeLink(openSheet)

    const goBack = link({ action: 'back', targetPageId: null, transition: undefined })
    store.followPrototypeLink(goBack)
    expect(currentOverlay(useEditorStore.getState().playState)).toBeNull()
    expect(currentScreen(useEditorStore.getState().playState, 'sign-up')).toBe('sms')

    store.followPrototypeLink(goBack)
    expect(currentScreen(useEditorStore.getState().playState, 'sign-up')).toBe('sign-up')
    // Reversed, so the pop moves the opposite way to the push.
    expect(useEditorStore.getState().playTransition).toBe('slide-right')
  })
})
