import { LIVE_COLOR_COUNT } from './constants'

/** The identity colour of a member: a design token, never a raw value. */
export function liveColorVar(colorIndex: number): string {
  const n = Math.min(Math.max(Math.trunc(colorIndex), 1), LIVE_COLOR_COUNT)
  return `var(--accent-${n})`
}

/**
 * The least-used colour index given those in use; ties go to the lowest index,
 * so join order decides and the first ten members all differ.
 */
export function pickColorIndex(inUse: readonly number[]): number {
  const counts = new Array<number>(LIVE_COLOR_COUNT + 1).fill(0)
  for (const index of inUse) {
    if (index >= 1 && index <= LIVE_COLOR_COUNT) counts[index] = (counts[index] ?? 0) + 1
  }
  let best = 1
  for (let i = 2; i <= LIVE_COLOR_COUNT; i++) {
    if ((counts[i] ?? 0) < (counts[best] ?? 0)) best = i
  }
  return best
}
