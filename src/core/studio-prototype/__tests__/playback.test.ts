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
  delayTriggersForScreen,
  linkForKey,
  linkForTrigger,
  releaseActionFor,
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
    trigger: { kind: 'click' },
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

describe('linkForTrigger', () => {
  const cardLink = link({ id: 'card' })
  const buttonLink = link({ id: 'button' })
  const resolved = new Map([
    ['card', 'card-node'],
    ['button', 'button-node'],
  ])

  it('follows the innermost link, not the one you happened to be inside', () => {
    // A linked button inside a linked card: you followed the thing you clicked.
    const chain = ['button-node', 'card-node', 'root']
    expect(linkForTrigger([cardLink, buttonLink], resolved, chain, 'welcome', 'click')?.id).toBe('button')
  })

  it('falls through to an ancestor when the clicked element itself has none', () => {
    const chain = ['label-node', 'card-node', 'root']
    expect(linkForTrigger([cardLink, buttonLink], resolved, chain, 'welcome', 'click')?.id).toBe('card')
  })

  it('is null when nothing in the chain is linked', () => {
    expect(linkForTrigger([cardLink], resolved, ['stray', 'root'], 'welcome', 'click')).toBeNull()
  })

  it('ignores links belonging to another page', () => {
    expect(linkForTrigger([cardLink], resolved, ['card-node'], 'sign-in', 'click')).toBeNull()
  })

  it('cannot follow a link whose source no longer resolves', () => {
    // A `detached` link has no entry in the resolution map. Refusing it here is
    // why it is DRAWN broken rather than dropped: a silent refusal would be
    // indistinguishable from a link that was never created.
    expect(linkForTrigger([cardLink], new Map(), ['card-node'], 'welcome', 'click')).toBeNull()
  })

  it('matches the trigger exactly — a click never follows a hover link', () => {
    // Two triggers on one element are two statements the user made separately.
    // Falling back would fire the wrong one on the gesture the other was for.
    const hoverLink = link({ id: 'card', trigger: { kind: 'hover' } })
    expect(linkForTrigger([hoverLink], resolved, ['card-node'], 'welcome', 'click')).toBeNull()
    expect(linkForTrigger([hoverLink], resolved, ['card-node'], 'welcome', 'hover')?.id).toBe('card')
  })

  it('lets one element carry a hover link and a click link at once', () => {
    const peek = link({ id: 'card', trigger: { kind: 'hover' }, targetPageId: 'preview' })
    const open = link({ id: 'card-click', targetPageId: 'sign-in' })
    const both = [peek, { ...open, source: peek.source }]
    const map = new Map([
      ['card', 'card-node'],
      ['card-click', 'card-node'],
    ])
    expect(linkForTrigger(both, map, ['card-node'], 'welcome', 'hover')?.targetPageId).toBe('preview')
    expect(linkForTrigger(both, map, ['card-node'], 'welcome', 'click')?.targetPageId).toBe('sign-in')
  })
})

describe('key triggers', () => {
  const enter = link({ id: 'enter', trigger: { kind: 'key', key: 'Enter' } })
  const resolved = new Map([['enter', 'cta-node']])

  it('matches case-insensitively — caps lock is not a different key', () => {
    const k = link({ id: 'enter', trigger: { kind: 'key', key: 'k' } })
    expect(linkForKey([k], resolved, 'welcome', 'K')?.id).toBe('enter')
  })

  it('is scoped to the screen showing, not to a pointer', () => {
    expect(linkForKey([enter], resolved, 'welcome', 'Enter')?.id).toBe('enter')
    expect(linkForKey([enter], resolved, 'sign-in', 'Enter')).toBeNull()
  })

  it('ignores a link whose source no longer resolves', () => {
    expect(linkForKey([enter], new Map(), 'welcome', 'Enter')).toBeNull()
  })

  it('ignores a link that is not a key trigger at all', () => {
    expect(linkForKey([link({ id: 'enter' })], resolved, 'welcome', 'Enter')).toBeNull()
  })
})

describe('after-delay triggers', () => {
  const splash = link({ id: 'splash', trigger: { kind: 'after-delay', ms: 1500 } })
  const resolved = new Map([['splash', 'root-node']])

  it('reports what arriving on a screen owes, and schedules nothing itself', () => {
    expect(delayTriggersForScreen([splash], resolved, 'welcome')).toEqual([
      { link: splash, ms: 1500 },
    ])
  })

  it('leaves out the other screens, the other triggers and the broken links', () => {
    expect(delayTriggersForScreen([splash], resolved, 'sign-in')).toEqual([])
    expect(delayTriggersForScreen([link()], resolved, 'welcome')).toEqual([])
    expect(delayTriggersForScreen([splash], new Map(), 'welcome')).toEqual([])
  })
})

describe('what letting go of a press undoes', () => {
  it('reverses a navigate with a back and an overlay with a close', () => {
    const peek = link({ trigger: { kind: 'press', reverseOnRelease: true } })
    expect(releaseActionFor(peek)?.action).toBe('back')
    expect(releaseActionFor(peek)?.targetPageId).toBeNull()

    const sheet = link({
      action: 'overlay',
      transition: 'sheet',
      trigger: { kind: 'press', reverseOnRelease: true },
    })
    expect(releaseActionFor(sheet)?.action).toBe('close')
  })

  it('actually pops the stack when applied', () => {
    const peek = link({ trigger: { kind: 'press', reverseOnRelease: true } })
    const pressed = apply(INITIAL_PLAY_STATE, peek)
    expect(currentScreen(pressed, 'welcome')).toBe('sign-in')
    expect(currentScreen(apply(pressed, releaseActionFor(peek)!), 'welcome')).toBe('welcome')
  })

  it('is null when the press was not asked to come back, or there is nothing to undo', () => {
    expect(releaseActionFor(link({ trigger: { kind: 'press', reverseOnRelease: false } }))).toBeNull()
    expect(releaseActionFor(link())).toBeNull()
    expect(
      releaseActionFor(
        link({ action: 'back', targetPageId: null, transition: undefined, trigger: { kind: 'press', reverseOnRelease: true } }),
      ),
    ).toBeNull()
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
