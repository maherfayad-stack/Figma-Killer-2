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

describe('the screen stack', () => {
  it('starts on the entry screen and shows what navigate pushed', () => {
    expect(currentScreen(INITIAL_PLAY_STATE, 'welcome')).toBe('welcome')
    const next = applyPlayAction(INITIAL_PLAY_STATE, link())
    expect(currentScreen(next, 'welcome')).toBe('sign-in')
  })

  it('goes back to where it came from', () => {
    const forward = applyPlayAction(INITIAL_PLAY_STATE, link())
    const back = applyPlayAction(forward, link({ action: 'back', targetPageId: null }))
    expect(currentScreen(back, 'welcome')).toBe('welcome')
  })

  it('is a no-op — same object — when back has nowhere to go', () => {
    // A back button on the entry screen is a real prototype bug, and the player
    // is where it should show up. Returning the same object lets the caller
    // skip the write and say so.
    const state = applyPlayAction(INITIAL_PLAY_STATE, link({ action: 'back', targetPageId: null }))
    expect(state).toBe(INITIAL_PLAY_STATE)
    expect(canGoBack(INITIAL_PLAY_STATE)).toBe(false)
  })
})

describe('overlays', () => {
  const openSheet = link({ id: 'sheet', action: 'overlay', targetPageId: 'filters', transition: 'sheet' })

  it('presents on top without leaving the screen', () => {
    const state = applyPlayAction(INITIAL_PLAY_STATE, openSheet)
    expect(currentScreen(state, 'welcome')).toBe('welcome')
    expect(currentOverlay(state)).toBe('filters')
  })

  it('close dismisses the top overlay only', () => {
    const two = applyPlayAction(applyPlayAction(INITIAL_PLAY_STATE, openSheet), link({ id: 'b', action: 'overlay', targetPageId: 'sort', transition: 'popup' }))
    const closed = applyPlayAction(two, link({ action: 'close', targetPageId: null }))
    expect(currentOverlay(closed)).toBe('filters')
  })

  it('back closes an overlay before it pops a screen', () => {
    // What the gesture means to someone looking at a sheet over a screen.
    const state = applyPlayAction(applyPlayAction(INITIAL_PLAY_STATE, link()), openSheet)
    const back = applyPlayAction(state, link({ action: 'back', targetPageId: null }))
    expect(currentOverlay(back)).toBeNull()
    expect(currentScreen(back, 'welcome')).toBe('sign-in')
  })

  it('navigating out from under an overlay drops it', () => {
    // The overlay belonged to the screen being left. Keeping it would leave a
    // sheet floating over a page it was never opened from.
    const state = applyPlayAction(applyPlayAction(INITIAL_PLAY_STATE, openSheet), link({ id: 'go', targetPageId: 'otp' }))
    expect(currentOverlay(state)).toBeNull()
    expect(currentScreen(state, 'welcome')).toBe('otp')
  })

  it('close is a no-op when nothing is presented', () => {
    const state: PlayState = INITIAL_PLAY_STATE
    expect(applyPlayAction(state, link({ action: 'close', targetPageId: null }))).toBe(state)
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
