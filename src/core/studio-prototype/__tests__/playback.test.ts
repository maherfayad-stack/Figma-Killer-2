/**
 * The player as a stack machine: what a click follows, and what the two stacks
 * look like afterwards.
 */
import { describe, it, expect } from 'bun:test'
import {
  INITIAL_PLAY_STATE,
  applyPlayAction,
  canGoBack,
  currentOverlay,
  currentScreen,
  linkForClick,
  reverseTransition,
  type PlayState,
  type PrototypeLink,
} from '..'

function link(overrides: Partial<PrototypeLink> = {}): PrototypeLink {
  return {
    id: 'link-1',
    origin: 'design',
    source: {
      pageId: 'welcome',
      node: { nodeId: 'cta', indexPath: [0], moduleId: 'base.button', textSnippet: 'Continue' },
    },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'sign-in',
    transition: 'slide-left',
    ...overrides,
  }
}

/** The stack after applying a link — the part most assertions are about. */
function apply(state: PlayState, l: PrototypeLink): PlayState {
  return applyPlayAction(state, l).state
}

const goBack = link({ action: 'back', targetPageId: null, transition: undefined })

describe('the screen stack', () => {
  it('starts on the entry screen and shows what navigate pushed', () => {
    expect(currentScreen(INITIAL_PLAY_STATE, 'welcome')).toBe('welcome')
    const next = apply(INITIAL_PLAY_STATE, link())
    expect(currentScreen(next, 'welcome')).toBe('sign-in')
  })

  it('goes back to where it came from', () => {
    const forward = apply(INITIAL_PLAY_STATE, link())
    expect(currentScreen(apply(forward, goBack), 'welcome')).toBe('welcome')
  })

  it('is a no-op — same object — when back has nowhere to go', () => {
    // A back button on the entry screen is a real prototype bug, and the player
    // is where it should show up. Returning the same object lets the caller
    // skip the write and say so.
    const outcome = applyPlayAction(INITIAL_PLAY_STATE, goBack)
    expect(outcome.state).toBe(INITIAL_PLAY_STATE)
    expect(outcome.entering).toBeNull()
    expect(canGoBack(INITIAL_PLAY_STATE)).toBe(false)
  })
})

describe('going back reverses how you arrived', () => {
  // A pop with no animation sitting next to a 420ms push reads as a bug, and
  // `back` carries no transition of its own — so the stack remembers.
  it('pops a push-left with a push-right', () => {
    const forward = apply(INITIAL_PLAY_STATE, link({ transition: 'push-left' }))
    expect(applyPlayAction(forward, goBack).entering).toBe('push-right')
  })

  it('leaves a symmetrical presentation alone', () => {
    expect(reverseTransition('dissolve')).toBe('dissolve')
    expect(reverseTransition('sheet')).toBe('sheet')
  })

  it('reports the overlay it dismissed so it can be played out', () => {
    const presented = apply(INITIAL_PLAY_STATE, link({ action: 'overlay', targetPageId: 'filters', transition: 'sheet' }))
    const outcome = applyPlayAction(presented, goBack)
    expect(outcome.leaving).toBe('sheet')
    // Nothing arrives — the screen underneath was never unmounted.
    expect(outcome.entering).toBeNull()
  })
})

describe('overlays', () => {
  const openSheet = link({ id: 'sheet', action: 'overlay', targetPageId: 'filters', transition: 'sheet' })

  it('presents on top without leaving the screen', () => {
    const state = apply(INITIAL_PLAY_STATE, openSheet)
    expect(currentScreen(state, 'welcome')).toBe('welcome')
    expect(currentOverlay(state)).toBe('filters')
  })

  it('close dismisses the top overlay only', () => {
    const two = apply(apply(INITIAL_PLAY_STATE, openSheet), link({ id: 'b', action: 'overlay', targetPageId: 'sort', transition: 'popup' }))
    const closed = apply(two, link({ action: 'close', targetPageId: null, transition: undefined }))
    expect(currentOverlay(closed)).toBe('filters')
  })

  it('back closes an overlay before it pops a screen', () => {
    // What the gesture means to someone looking at a sheet over a screen.
    const state = apply(apply(INITIAL_PLAY_STATE, link()), openSheet)
    const back = apply(state, goBack)
    expect(currentOverlay(back)).toBeNull()
    expect(currentScreen(back, 'welcome')).toBe('sign-in')
  })

  it('navigating out from under an overlay drops it', () => {
    // The overlay belonged to the screen being left. Keeping it would leave a
    // sheet floating over a page it was never opened from.
    const state = apply(apply(INITIAL_PLAY_STATE, openSheet), link({ id: 'go', targetPageId: 'otp' }))
    expect(currentOverlay(state)).toBeNull()
    expect(currentScreen(state, 'welcome')).toBe('otp')
  })

  it('close is a no-op when nothing is presented', () => {
    // `close` is only ever about an overlay — unlike `back`, it does NOT go on
    // to pop the screen stack.
    const state: PlayState = INITIAL_PLAY_STATE
    expect(applyPlayAction(state, link({ action: 'close', targetPageId: null, transition: undefined })).state).toBe(state)
  })
})

describe('linkForClick', () => {
  const cardLink = link({ id: 'card' })
  const buttonLink = link({ id: 'button' })
  const resolved = new Map([
    ['card', 'card-node'],
    ['button', 'button-node'],
  ])

  it('follows the innermost link, not the one you happened to be inside', () => {
    // A linked button inside a linked card: you followed the thing you clicked.
    const chain = ['button-node', 'card-node', 'root']
    expect(linkForClick([cardLink, buttonLink], resolved, chain, 'welcome')?.id).toBe('button')
  })

  it('falls through to an ancestor when the clicked element itself has none', () => {
    const chain = ['label-node', 'card-node', 'root']
    expect(linkForClick([cardLink, buttonLink], resolved, chain, 'welcome')?.id).toBe('card')
  })

  it('is null when nothing in the chain is linked', () => {
    expect(linkForClick([cardLink], resolved, ['stray', 'root'], 'welcome')).toBeNull()
  })

  it('ignores links belonging to another page', () => {
    expect(linkForClick([cardLink], resolved, ['card-node'], 'sign-in')).toBeNull()
  })

  it('cannot follow a link whose source no longer resolves', () => {
    // A `detached` link has no entry in the resolution map. Refusing it here is
    // why it is DRAWN broken rather than dropped: a silent refusal would be
    // indistinguishable from a link that was never created.
    expect(linkForClick([cardLink], new Map(), ['card-node'], 'welcome')).toBeNull()
  })
})

describe('a changed state aliases nothing from the old one', () => {
  // The editor store calls this with a Mutative DRAFT. An object assigned back
  // into a draft while still holding references into that same draft does not
  // survive finalization: the scalars written beside it stick and the stack
  // silently does not, which showed up as a bottom sheet that would not close.
  it('copies every entry it carries forward', () => {
    const first = apply(INITIAL_PLAY_STATE, link({ targetPageId: 'sign-in' }))
    const second = apply(first, link({ id: 'b', targetPageId: 'otp' }))

    expect(second.screens).not.toBe(first.screens)
    for (const carried of second.screens) {
      expect(first.screens).not.toContain(carried)
    }
  })

  it('copies the untouched stack too, not just the one it changed', () => {
    const presented = apply(
      apply(INITIAL_PLAY_STATE, link()),
      link({ id: 'sheet', action: 'overlay', targetPageId: 'filters', transition: 'sheet' }),
    )
    const closed = apply(presented, link({ action: 'close', targetPageId: null, transition: undefined }))

    // `screens` was not what `close` acted on, and is exactly the array a
    // spread would have handed straight back.
    expect(closed.screens).not.toBe(presented.screens)
    expect(closed.screens[0]).not.toBe(presented.screens[0])
    expect(closed.screens).toEqual(presented.screens)
  })
})
