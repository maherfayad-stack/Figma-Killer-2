/**
 * usePopoverFlip — "open to the left instead, you are about to run off the
 * canvas".
 *
 * Both comment popovers hang below-RIGHT of their pin by default and flip to
 * below-LEFT when that would put them past the canvas's right edge. Before the
 * comments list moved into the right sidebar this was a rare screen-edge case;
 * now the pane is a wall they meet on any pin in the right third of the board,
 * so the flip is not optional — and it has to behave identically for a draft
 * and for a committed thread, or placing a comment would visibly jump the
 * moment it was submitted.
 *
 * MEASURED, NOT DERIVED
 * ─────────────────────
 * Whether the popover fits depends on pan, zoom, the pane's current width and
 * the window's. Reconstructing that from state would be four things to keep in
 * sync with the DOM; it is one `getBoundingClientRect` to just ask.
 *
 * The measurement is taken from the PIN's wrapper, not from the popover's own
 * rect. The pin does not move when the popover flips, so the decision is a
 * fixed question with a stable answer. Measuring the popover would ask "does
 * where I am now overflow", which flips to a different answer each time it
 * moves — an oscillation.
 *
 * `useLayoutEffect` so the flip lands in the same frame the popover first
 * paints; a `useEffect` shows one frame in the clipped position. Panning and
 * zooming do not re-render these components (the transform layer is written
 * imperatively), so mount plus one confirming pass after a flip is the whole
 * lifecycle — hence the `[flipped]` dep list.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface PopoverFlip {
  /** Attach to the popover element itself. */
  ref: RefObject<HTMLDivElement | null>
  /** True when the popover should open to the left of its pin. */
  flipped: boolean
}

export function usePopoverFlip(): PopoverFlip {
  const ref = useRef<HTMLDivElement>(null)
  const [flipped, setFlipped] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    // `BoardCommentsLayer` positions the popover's parent at the anchor point.
    const anchor = el?.parentElement
    const canvas = el?.closest('[data-testid="canvas-root"]')
    if (!el || !anchor || !canvas) return
    const fitsOnTheRight =
      anchor.getBoundingClientRect().left + el.getBoundingClientRect().width <=
      canvas.getBoundingClientRect().right
    if (fitsOnTheRight === flipped) setFlipped(!fitsOnTheRight)
  }, [flipped])

  return { ref, flipped }
}
