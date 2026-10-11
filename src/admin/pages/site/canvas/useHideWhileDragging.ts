/**
 * useHideWhileDragging - hide a piece of selection chrome for the length of a
 * drag.
 *
 * The floating toolbar is anchored to where the dragged element WAS; once the
 * element follows the pointer away the bar is left hanging over its neighbours
 * for the whole gesture. `visibility` rather than `display`: the overlay's
 * measure pass owns `display` and the placement (`positionToolbar`), so the
 * two cannot fight, and a toolbar that STARTED the drag (its grab handle) keeps
 * its pointer capture.
 */
import { useEffect, type RefObject } from 'react'

export function useHideWhileDragging(ref: RefObject<HTMLElement | null>, dragging: boolean): void {
  useEffect(() => {
    const element = ref.current
    if (!element || !dragging) return
    element.style.visibility = 'hidden'
    return () => {
      element.style.visibility = ''
    }
  }, [ref, dragging])
}
