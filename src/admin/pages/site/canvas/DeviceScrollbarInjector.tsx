/**
 * DeviceScrollbarInjector — hides scrollbars inside the live iframe while a
 * device mockup is drawn around it.
 *
 * A phone does not have a scrollbar track down the side of the screen, so one
 * sitting inside the bezel is the single detail that most breaks the illusion
 * — and worse, it is a strip of chrome the author's design will never actually
 * have to live next to. Desktop and fluid live mode keep their scrollbars,
 * because there the scrollbar IS what a visitor sees.
 *
 * ## Scrolling still works
 *
 * This hides the scrollbar, it does not stop the scrolling: `scrollbar-width:
 * none` and a zero-size `::-webkit-scrollbar` leave wheel, trackpad, keyboard
 * and programmatic scrolling untouched. Setting `overflow: hidden` instead
 * would have removed the scrollbar by making a tall page unreachable, which is
 * a different and much worse thing.
 *
 * ## Why every scrollbar, not just the root one
 *
 * The rule is unscoped on purpose. A real iOS/iPadOS device paints no
 * persistent scrollbar on ANY scroll container — inner ones included — so
 * hiding only the root scroller would leave an authored `overflow: auto` panel
 * showing a desktop-style track that the device it is emulating never shows.
 *
 * This is a deliberate, mockup-only departure from "the canvas renders exactly
 * what the code renders": measured against a desktop browser the scrollbars
 * are missing, but measured against the phone the mockup is imitating they are
 * correctly absent. It is scoped to the device chrome and never reaches design
 * mode, desktop live mode, or the publisher.
 *
 * ## Layout is unaffected
 *
 * On overlay-scrollbar platforms (measured here: `innerWidth === clientWidth
 * === 375`) the scrollbar already consumed no layout width, so hiding it moves
 * nothing. On a classic-scrollbar platform it RECLAIMS the ~15px the track was
 * taking, which moves the page closer to its true breakpoint width, not
 * further from it — so this can only improve the width fidelity live mode
 * exists for.
 */

import { useEffect } from 'react'

const STYLE_ELEMENT_ID = 'studio-device-scrollbars'

const HIDE_SCROLLBARS_CSS = `
:where(html, body) { scrollbar-width: none; }
::-webkit-scrollbar { width: 0; height: 0; display: none; }
`.trim()

interface DeviceScrollbarInjectorProps {
  /** The live iframe's document. `null` until it loads. */
  targetDocument: Document | null
  /** True only while a device mockup is drawn. */
  hidden: boolean
}

export function DeviceScrollbarInjector({ targetDocument, hidden }: DeviceScrollbarInjectorProps) {
  useEffect(() => {
    const head = targetDocument?.head
    if (!head) return
    // Removed rather than emptied when the author switches to desktop, so the
    // iframe document is left exactly as it would be had no device ever been
    // drawn — no inert element for the next person to wonder about.
    if (!hidden) {
      head.querySelector(`#${STYLE_ELEMENT_ID}`)?.remove()
      return
    }
    const existing = head.querySelector(`#${STYLE_ELEMENT_ID}`)
    if (existing) return
    const style = targetDocument.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent = HIDE_SCROLLBARS_CSS
    head.appendChild(style)
    return () => style.remove()
  }, [targetDocument, hidden])

  return null
}
