/**
 * useAutoFitText — shrinks a sticky note's text until it fits the note.
 *
 * A Miro sticky is a fixed rectangle whose text scales to fill it: you resize
 * the note, not the type. Without this a long note either clips (losing text
 * with no indication) or scrolls (a scrollbar inside a 180px square on an
 * infinite canvas, which nobody finds).
 *
 * Binary search over the font-size range, not a linear walk: a note that is
 * far too full converges in ~5 measurements instead of ~30, and every
 * measurement is a forced synchronous layout. The search runs in
 * `useLayoutEffect` so the fitted size is committed before the browser paints
 * — a linear walk visible as the text "settling" is exactly the artefact this
 * avoids.
 *
 * Re-runs on text change and on element resize (`ResizeObserver`), which is
 * what makes drag-resizing a note re-fit continuously.
 *
 * **The content and the box are two different elements.** The box is the
 * note's fixed, centred, clipping rectangle; the content is the text inside
 * it. Measuring the content against ITSELF (the shape this hook originally
 * had) only works while the box and the content are the same element, i.e.
 * while the text is top-aligned. A vertically centred overflow escapes the box
 * in both directions and `scrollHeight` reports none of it, so a note would
 * settle at a font size whose first and last lines were invisible.
 *
 * Deliberately NOT applied to doc cards: a doc is a document — it has real
 * typography the author chose, scrolls when it overflows, and must not have
 * its font size silently overridden.
 */
import { useLayoutEffect, type RefObject } from 'react'

/** Bounds of the search, in px. The floor is the smallest size that stays legible at 100% zoom; the ceiling is the size an empty note starts at. */
export const AUTO_FIT_MIN_FONT_PX = 8
export const AUTO_FIT_MAX_FONT_PX = 28

/** Sub-pixel precision buys nothing visible and costs measurements. */
const PRECISION_PX = 0.5

function fits(content: HTMLElement, box: HTMLElement): boolean {
  // +1 absorbs sub-pixel rounding in scrollHeight, which otherwise reports a
  // one-line note as overflowing its own exact height.
  return content.scrollHeight <= box.clientHeight + 1
}

/**
 * Applies the largest font size in [min, max] at which `content` fits inside
 * `box`. Writes `font-size` directly on the element rather than through React
 * state: it is the OUTPUT of a measurement of that same element, so routing it
 * through a render would measure, re-render, and re-measure on every keystroke.
 */
export function fitTextToBox(
  content: HTMLElement,
  box: HTMLElement,
  min = AUTO_FIT_MIN_FONT_PX,
  max = AUTO_FIT_MAX_FONT_PX,
): void {
  content.style.fontSize = `${max}px`
  if (fits(content, box)) return

  let low = min
  let high = max
  while (high - low > PRECISION_PX) {
    const mid = (low + high) / 2
    content.style.fontSize = `${mid}px`
    if (fits(content, box)) low = mid
    else high = mid
  }
  content.style.fontSize = `${low}px`
}

/**
 * Keeps `contentRef`'s text fitted inside `boxRef`. `text` is a dependency so
 * typing re-fits; the `ResizeObserver` covers drag-resize and zoom-driven
 * layout changes, which no dependency array can see.
 */
export function useAutoFitText(
  contentRef: RefObject<HTMLElement | null>,
  boxRef: RefObject<HTMLElement | null>,
  text: string,
): void {
  useLayoutEffect(() => {
    const content = contentRef.current
    const box = boxRef.current
    if (!content || !box) return
    fitTextToBox(content, box)
    if (typeof ResizeObserver === 'undefined') return
    // Observes the BOX: it is the element the note's geometry resizes, and the
    // content's own size is this hook's output — observing that would feed the
    // search back into itself.
    const observer = new ResizeObserver(() => fitTextToBox(content, box))
    observer.observe(box)
    return () => observer.disconnect()
  }, [contentRef, boxRef, text])
}
