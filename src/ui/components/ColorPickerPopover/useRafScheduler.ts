import { useEffect, useRef } from 'react'

/**
 * rAF-coalesced scheduler — same policy `ScrubInput` uses for its drag
 * preview channel: a fast drag (well over 60Hz on a high-poll-rate pointer)
 * collapses to at most one call per animation frame, so a live preview
 * channel wired all the way to a store write never does more work than the
 * screen can paint.
 */
export function useRafScheduler() {
  const rafIdRef = useRef<number | null>(null)
  const pendingRef = useRef<(() => void) | null>(null)

  function schedule(run: () => void) {
    pendingRef.current = run
    if (rafIdRef.current !== null) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      const next = pendingRef.current
      pendingRef.current = null
      next?.()
    })
  }

  function cancel() {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = null
    pendingRef.current = null
  }

  // Abandoned-drag safety (selection changes / popover closes mid-drag) —
  // mirrors ScrubInput's identical unmount effect.
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
    }
  }, [])

  return { schedule, cancel }
}
