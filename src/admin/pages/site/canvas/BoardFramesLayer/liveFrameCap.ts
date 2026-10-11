/**
 * liveFrameCap — how many board frames may hold a live iframe, and which ones
 * (SB-2; owner decision 2026-10-10, `docs/decisions.md`).
 *
 * The rule: as many live screens as the machine affords. Default
 * {@link LIVE_CAP_DEFAULT} (20); more when memory allows it, scaled by what a
 * live frame was actually measured to cost; never below {@link LIVE_CAP_FLOOR}
 * (12). Every other screen is a poster. Below {@link POSTER_ZOOM} (0.35) a
 * frame is too small to read, so only the frames the user is working in stay
 * live and everything else is a poster, whatever the cap.
 *
 * Frames the user is working in — selected, being edited, in play mode —
 * are live regardless of cap and zoom, and do not count against it: a cap must
 * never take a document out from under a selection. Editing a poster frame
 * therefore promotes it to live (it enters `working`), and that is the only
 * promotion rule; hovering never promotes.
 *
 * Pure — no DOM, no store — so the policy is unit-tested apart from whoever
 * applies it. Poster-first mounting (SB-5) reads {@link selectLiveFrames};
 * until then `framePool.ts` still decides the mount and this is the contract
 * it will be replaced by.
 */

/** Live frames when nothing has been measured and the machine reports 8 GB or more. */
export const LIVE_CAP_DEFAULT = 20

/** The cap never goes below this, however little memory the machine reports. */
export const LIVE_CAP_FLOOR = 12

/** The cap never goes above this: past it the cost is the dev server and the compositor, not heap. */
export const LIVE_CAP_CEILING = 48

/** Below this zoom a screen is a picture, not a document. */
export const POSTER_ZOOM = 0.35

/** Share of device memory live frames may use. */
const LIVE_MEMORY_SHARE = 0.1

export interface LiveCapMemory {
  /** `navigator.deviceMemory` in GB (the browser rounds it down to a power of two, max 8). Absent: unknown. */
  deviceMemoryGb?: number
  /**
   * Measured cost of one live frame, bytes (heap delta per mounted frame,
   * including its document). Absent until at least one frame has been measured.
   */
  heapBytesPerLiveFrame?: number
}

/** The cap for this machine. */
export function computeLiveFrameCap({ deviceMemoryGb, heapBytesPerLiveFrame }: LiveCapMemory): number {
  const memoryBytes = (deviceMemoryGb ?? 8) * 1024 ** 3
  if (heapBytesPerLiveFrame === undefined || heapBytesPerLiveFrame <= 0) {
    // Nothing measured: scale the default by memory, 8 GB and up -> 20, 4 GB -> 14, 2 GB and under -> 12.
    return clamp(Math.round(LIVE_CAP_DEFAULT * Math.sqrt(memoryBytes / 1024 ** 3 / 8)), LIVE_CAP_FLOOR, LIVE_CAP_DEFAULT)
  }
  return clamp(Math.floor((memoryBytes * LIVE_MEMORY_SHARE) / heapBytesPerLiveFrame), LIVE_CAP_FLOOR, LIVE_CAP_CEILING)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface LiveFrameCandidate {
  id: string
  /** The frame intersects the viewport (without the prefetch margin). */
  inView: boolean
  /** Screen-space distance from the frame's centre to the viewport's centre, px. */
  distanceToCenter: number
}

export interface LiveFrameSelectionInput extends LiveCapMemory {
  frames: readonly LiveFrameCandidate[]
  zoom: number
  selectedFrameIds: ReadonlySet<string>
  editingFrameId: string | null
  /** The frame in play / live mode, if any. */
  playFrameId: string | null
}

export type LiveFrameReason = 'selected' | 'editing' | 'play' | 'in-view'

export interface LiveFrameSelection {
  cap: number
  /** Live frames and why, in rank order: working frames first, then nearest to the viewport centre. */
  live: ReadonlyMap<string, LiveFrameReason>
}

/** Which frames are live. Every frame not in `live` is a poster. */
export function selectLiveFrames(input: LiveFrameSelectionInput): LiveFrameSelection {
  const cap = computeLiveFrameCap(input)
  const live = new Map<string, LiveFrameReason>()
  const known = new Set(input.frames.map((frame) => frame.id))

  if (input.playFrameId !== null && known.has(input.playFrameId)) live.set(input.playFrameId, 'play')
  if (input.editingFrameId !== null && known.has(input.editingFrameId) && !live.has(input.editingFrameId)) {
    live.set(input.editingFrameId, 'editing')
  }
  for (const frame of input.frames) {
    if (input.selectedFrameIds.has(frame.id) && !live.has(frame.id)) live.set(frame.id, 'selected')
  }

  if (input.zoom >= POSTER_ZOOM) {
    const ranked = input.frames
      .filter((frame) => frame.inView && !live.has(frame.id))
      .sort((a, b) => a.distanceToCenter - b.distanceToCenter)
    for (const frame of ranked.slice(0, cap)) live.set(frame.id, 'in-view')
  }
  return { cap, live }
}
