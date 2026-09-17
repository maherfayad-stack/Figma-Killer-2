/**
 * PrototypeScreenStack — the two screen slots a navigation animates between.
 *
 * WHY TWO, AND WHY BOTH STAY MOUNTED
 * ──────────────────────────────────
 * A `push` moves the DEPARTING screen too — it parallaxes back a third of the
 * way and darkens under the arriving one, which is what stops the motion
 * reading as a cross-dissolve. That needs both screens on screen at once.
 *
 * Each screen is an `<iframe>`, and an iframe is not a cheap thing to create:
 * a fresh one has to load, have every stylesheet re-injected, and have React
 * re-establish the portal that renders the page into its body. Mounting one per
 * navigation would flash an empty device at the start of every transition — the
 * exact failure that keying the old single slot on the page id produced. So
 * both slots are mounted for the life of the player and the pages MOVE BETWEEN
 * THEM: the arriving page renders into whichever slot is currently in back,
 * that slot comes to the front, and the two swap roles again on the next
 * navigation.
 *
 * The back slot holds no page until the first navigation, so that one
 * navigation does pay for an iframe mount. Every one after it is free, which is
 * the difference that matters: the bug this replaced remounted on EVERY
 * navigation. Pre-warming the second frame would mean rendering a page into it
 * that nobody is looking at, for the whole session, to save one mount.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Page } from '@core/page-tree'
import { matchScreenNodes, type PrototypeTransition } from '@core/studio-prototype'
import { DUR_SMART_ANIMATE, play, screenMotion } from './playbackMotion'
import { planSmartAnimate, runSmartAnimate } from './smartAnimateFlip'
import styles from './CanvasLiveSurface.module.css'

type SlotName = 'a' | 'b'

interface StackState {
  front: SlotName
  a: Page | null
  b: Page | null
  /** Increments once per navigation, so the animation effect fires exactly once. */
  nav: number
  /** The slot the navigation is leaving, kept visible until its animation ends. */
  leaving: SlotName | null
}

interface PrototypeScreenStackProps {
  /** The screen the player is on. */
  page: Page
  /** How it should arrive. `null` on the first mount — nothing to animate from. */
  transition: PrototypeTransition | null
  /** Renders one screen's frame. Called for each slot that has a page. */
  renderScreen: (page: Page) => ReactNode
}

export function PrototypeScreenStack({ page, transition, renderScreen }: PrototypeScreenStackProps) {
  const [stack, setStack] = useState<StackState>(() => ({
    front: 'a',
    a: page,
    b: null,
    nav: 0,
    leaving: null,
  }))
  const aRef = useRef<HTMLDivElement | null>(null)
  const bRef = useRef<HTMLDivElement | null>(null)
  const ghostLayerRef = useRef<HTMLDivElement | null>(null)

  // Adjusting state during render — the documented React pattern for "a prop
  // changed and derived state has to follow", and the reason this is not an
  // effect: an effect would paint the new screen in place for one frame before
  // the animation's first keyframe moved it off, which is a visible flash.
  if (stack[stack.front]?.id !== page.id) {
    const back: SlotName = stack.front === 'a' ? 'b' : 'a'
    setStack({
      front: back,
      a: back === 'a' ? page : stack.a,
      b: back === 'b' ? page : stack.b,
      nav: stack.nav + 1,
      leaving: stack[stack.front] ? stack.front : null,
    })
  }

  const { front, leaving, nav } = stack
  // Derived here rather than read off `stack` inside the effect: they change
  // exactly when `nav` does, so naming them lets the effect declare what it
  // actually depends on instead of the whole stack object.
  const incomingPage = stack[front]
  const outgoingPage = leaving ? stack[leaving] : null

  // `nav` counts navigations, so this runs once per one. `front` moves only
  // with it, and `transition` only changes when the link being followed does —
  // which is a new navigation too. No dependency here can fire a spurious
  // replay, so none of them needs to be hidden from the linter.
  useEffect(() => {
    if (nav === 0) return
    const incomingEl = front === 'a' ? aRef.current : bRef.current
    const outgoingEl = front === 'a' ? bRef.current : aRef.current
    const motion = transition ? screenMotion(transition) : null

    const settle = () => setStack((prev) => (prev.leaving === null ? prev : { ...prev, leaving: null }))
    if (!motion) {
      settle()
      return
    }

    const animations = [
      play(incomingEl, motion.incoming, motion.duration, motion.easing),
      // `both` on the way out: the departing screen has to HOLD its parallaxed
      // position until it is hidden, or it snaps back for a frame first.
      play(outgoingEl, motion.outgoing, motion.duration, motion.easing, 'both'),
      play(
        outgoingEl?.querySelector<HTMLElement>(`.${styles.screenDim}`) ?? null,
        motion.dim,
        motion.duration,
        motion.easing,
        'both',
      ),
    ].filter((animation): animation is Animation => animation !== null)

    if (animations.length === 0) {
      settle()
      return
    }

    let cancelled = false
    // Hide the departing screen only once it has finished leaving. Without the
    // wait it would vanish on the first frame and the parallax would animate
    // nothing; without hiding it at all it would sit a third of the way off,
    // still visible at the edge of a viewport that only clips the rest.
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) settle()
    })

    return () => {
      cancelled = true
      for (const animation of animations) animation.cancel()
    }
  }, [nav, front, transition])

  // ── Smart animate ────────────────────────────────────────────────────────
  //
  // A SECOND effect, on the same trigger, because it is a different claim with
  // a different shape: the one above animates the two screen slots and settles
  // the stack, this one measures matched elements across two documents and
  // flies ghosts between them. Merging them would put a two-frame measurement
  // pass inside the effect that has to start the dissolve on frame one.
  useEffect(() => {
    if (nav === 0 || transition !== 'smart-animate') return
    const layer = ghostLayerRef.current
    if (!layer || !outgoingPage || !incomingPage) return

    const matches = matchScreenNodes(outgoingPage, incomingPage).matched
    if (matches.length === 0) return

    let cancelled = false
    let stop: (() => void) | null = null
    // TWO frames, and both are load-bearing. The first lets the incoming slot
    // commit and lay out — on the very first navigation its iframe is mounting,
    // and measuring before that yields zeros. The second separates the READ
    // (`planSmartAnimate`) from the WRITE (`runSmartAnimate`): building an
    // element in the middle of a measurement loop is a forced reflow per pair,
    // across two documents.
    const measureFrame = requestAnimationFrame(() => {
      if (cancelled) return
      const fromSlot = leaving === 'a' ? aRef.current : bRef.current
      const toSlot = front === 'a' ? aRef.current : bRef.current
      const ghosts = planSmartAnimate(matches, fromSlot, toSlot, layer)
      if (ghosts.length === 0) return
      const runFrame = requestAnimationFrame(() => {
        if (cancelled) return
        stop = runSmartAnimate(layer, ghosts, DUR_SMART_ANIMATE)
      })
      stop = () => cancelAnimationFrame(runFrame)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(measureFrame)
      stop?.()
    }
  }, [nav, front, leaving, transition, outgoingPage, incomingPage])

  return (
    <>
      <Slot
        elementRef={aRef}
        page={stack.a}
        state={front === 'a' ? 'front' : leaving === 'a' ? 'leaving' : 'back'}
        renderScreen={renderScreen}
      />
      <Slot
        elementRef={bRef}
        page={stack.b}
        state={front === 'b' ? 'front' : leaving === 'b' ? 'leaving' : 'back'}
        renderScreen={renderScreen}
      />
      {/* Where a smart animate's ghosts fly. Editor chrome in the PARENT
          document, over both screens and inside neither — a matched pair spans
          two iframes and neither of them contains the travel between them.
          Always mounted: it costs one empty div, and a layer created at the
          moment a transition starts would have no laid-out rect to measure
          against on the frame the measurement happens. */}
      <div ref={ghostLayerRef} className={styles.smartAnimateLayer} aria-hidden="true" />
    </>
  )
}

function Slot({
  elementRef,
  page,
  state,
  renderScreen,
}: {
  elementRef: React.RefObject<HTMLDivElement | null>
  page: Page | null
  state: 'front' | 'back' | 'leaving'
  renderScreen: (page: Page) => ReactNode
}) {
  return (
    <div ref={elementRef} className={styles.prototypeScreen} data-slot-state={state}>
      {/* The departing screen DARKENS rather than fading — a fade would read as
          a cross-dissolve, and the screen is meant to still be there, behind. */}
      <div className={styles.screenDim} aria-hidden="true" />
      {page ? renderScreen(page) : null}
    </div>
  )
}
