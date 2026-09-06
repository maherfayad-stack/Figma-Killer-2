/**
 * PrototypeOverlay — a sheet or a popup presented over the screen that opened
 * it.
 *
 * WHY THIS OWNS ITS OWN MOUNTING
 * ──────────────────────────────
 * React removes a component the moment its parent stops rendering it, so an
 * overlay wired straight to "is one presented?" VANISHES rather than
 * dismissing. It has to outlive the state change that closed it: this component
 * keeps the last presented page mounted, plays the exit, and only then drops
 * it. That is the same shape the design system's own sheets use, and it is the
 * reason the dismissal is a real gesture rather than a cut.
 *
 * THE PAGE IS THE PRESENTATION
 * ────────────────────────────
 * This layer supplies motion and a dim, and NOTHING about the overlay's shape.
 * An overlay page is scaffolded at screen size and draws its own panel, its own
 * corner radius and its own scrim (`pageKinds.ts`), so a height chosen here
 * would be a second opinion about a decision the design already made — and the
 * fixed 40% top inset this used to carry cropped the top off every full-screen
 * sheet.
 *
 * The dim underneath is therefore all this adds. It is what the presenting
 * screen sits behind while the overlay is still on its way up, and what shows
 * through wherever an overlay page paints nothing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Page } from '@core/page-tree'
import type { PrototypeTransition } from '@core/studio-prototype'
import { overlayExitMotion, overlayMotion, play } from './playbackMotion'
import styles from './CanvasLiveSurface.module.css'

interface Presented {
  page: Page
  /** How it came in, so it can leave the same way if nothing says otherwise. */
  transition: PrototypeTransition | null
}

interface PrototypeOverlayProps {
  /** The overlay the player wants presented, or `null` to dismiss. */
  page: Page | null
  /** How it should arrive. */
  enterTransition: PrototypeTransition | null
  /** How the one that just left was presented, from the play stack. */
  leaveTransition: PrototypeTransition | null
  renderScreen: (page: Page) => ReactNode
}

export function PrototypeOverlay({
  page,
  enterTransition,
  leaveTransition,
  renderScreen,
}: PrototypeOverlayProps) {
  const [presented, setPresented] = useState<Presented | null>(
    page ? { page, transition: enterTransition } : null,
  )
  /**
   * Set the moment the overlay is asked to leave, carrying the presentation to
   * play in reverse. Held here rather than read in the exit effect so the
   * effect depends on ONE value that changes exactly once per dismissal.
   */
  const [closing, setClosing] = useState<{ transition: PrototypeTransition | null } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const scrimRef = useRef<HTMLDivElement | null>(null)

  // Adjusting state during render, the documented React pattern for "a prop
  // changed and derived state has to follow". An effect would paint one frame
  // of the new overlay in its final position before the entrance moved it.
  if (page && presented?.page.id !== page.id) {
    setPresented({ page, transition: enterTransition })
    setClosing(null)
  } else if (!page && presented && !closing) {
    // Prefer what the play stack says left; fall back to how this one arrived.
    setClosing({ transition: leaveTransition ?? presented.transition })
  }

  const presentedId = presented?.page.id ?? null

  useEffect(() => {
    if (!presentedId || closing) return
    const motion = enterTransition ? overlayMotion(enterTransition) : null
    if (!motion) return
    const animations = [
      play(panelRef.current, motion.panel, motion.duration, motion.easing),
      play(scrimRef.current, motion.scrim, motion.duration, motion.easing),
    ].filter((animation): animation is Animation => animation !== null)
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [presentedId, closing, enterTransition])

  useEffect(() => {
    if (!closing) return
    const drop = () => {
      setPresented(null)
      setClosing(null)
    }
    const motion = closing.transition ? overlayExitMotion(closing.transition) : null
    if (!motion) {
      drop()
      return
    }
    const animations = [
      play(panelRef.current, motion.panel, motion.duration, motion.easing, 'both'),
      play(scrimRef.current, motion.scrim, motion.duration, motion.easing, 'both'),
    ].filter((animation): animation is Animation => animation !== null)
    if (animations.length === 0) {
      drop()
      return
    }
    let cancelled = false
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) drop()
    })
    return () => {
      cancelled = true
      for (const animation of animations) animation.cancel()
    }
  }, [closing])

  if (!presented) return null

  return (
    <div className={styles.prototypeOverlay} data-testid="prototype-overlay">
      {/*
        Presentation only, and deliberately not interactive: the overlay page
        covers this completely, so a dismissal handler here could never fire.
        Closing an overlay is authored on the affordance the design actually
        drew — its close control gets a `close` link, one click in the
        Prototype panel.
      */}
      <div ref={scrimRef} className={styles.prototypeScrim} role="presentation" />
      <div ref={panelRef} className={styles.prototypeOverlayFrame}>
        {renderScreen(presented.page)}
      </div>
    </div>
  )
}
