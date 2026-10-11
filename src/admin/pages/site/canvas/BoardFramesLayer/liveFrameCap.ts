/**
 * liveFrameCap — how many board frames may hold a live iframe, and which ones
 * (SB-2 policy, SB-5 wiring; owner decision 2026-10-10, `docs/decisions.md`).
 *
 * The rule: as many live screens as the machine affords. Default
 * {@link LIVE_CAP_DEFAULT} (20); more when memory is free; never below
 * {@link LIVE_CAP_FLOOR} (12). Every other screen is a poster. Below
 * {@link POSTER_ZOOM} (0.35) a frame is too small to read, so only the frames
 * the user is working in stay live and everything else is a poster, whatever
 * the cap.
 *
 * Frames the user is working in — selected, being edited, in play mode —
 * are live regardless of cap and zoom, and do not count against it: a cap must
 * never take a document out from under a selection. Editing a poster frame
 * therefore promotes it to live (it enters `working`), and that is the only
 * promotion rule; hovering never promotes.
 *
 * Pure — no DOM, no store — so the policy is unit-tested apart from whoever
 * applies it. `BoardFramesLayer` reads {@link selectLiveFrames} and
 * {@link readLiveCapMemory}; this is the ONE place that says how many live
 * frames a board may hold (`board-live-frame-cap.test.ts` keeps it that way).
 */

/** Live frames when the machine reports 8 GB or more and nothing says memory is plentiful. */
export const LIVE_CAP_DEFAULT = 20

/** The cap never goes below this, however little memory the machine reports. */
export const LIVE_CAP_FLOOR = 12

/** The cap never goes above this: past it the cost is the compositor and style recalc, not heap. */
export const LIVE_CAP_CEILING = 48

/**
 * A Tier-2 (bridge) board's own cap: each live frame there is a cross-origin
 * document against a real dev-server process (plus its fallback until it
 * reports ready), roughly twice the documents of a portal frame. Exempt from
 * the floor. SB-8 lowers it again.
 */
export const LIVE_CAP_BRIDGE = 8

/** Below this zoom a screen is a picture, not a document. */
export const POSTER_ZOOM = 0.35

/** JS heap one live frame costs (document, React tree, style sheets), rounded up from the 100 x 140 corpus. */
export const LIVE_FRAME_HEAP_BYTES = 8 * 1024 * 1024

/** Share of the free JS heap live frames may use. */
const FREE_HEAP_SHARE = 0.05

/** Screen px of preference a frame that is already live gets over one that is not, so a pan does not swap equals. */
const RETAINED_BONUS_PX = 150

export interface LiveCapMemory {
  /** `navigator.deviceMemory` in GB (the browser rounds it down to a power of two, max 8). Absent: unknown. */
  deviceMemoryGb?: number
  /** Free JS heap, bytes (`jsHeapSizeLimit - usedJSHeapSize`; Chromium only). Absent: unknown. */
  freeHeapBytes?: number
  /** This board's live frames are cross-origin dev-server documents ({@link LIVE_CAP_BRIDGE}). */
  bridge?: boolean
}

/** The cap for this machine. */
export function computeLiveFrameCap({ deviceMemoryGb, freeHeapBytes, bridge }: LiveCapMemory): number {
  if (bridge) return LIVE_CAP_BRIDGE
  // Nothing else known: scale the default by memory, 8 GB and up -> 20, 4 GB -> 14, 2 GB and under -> 12.
  const byDevice = Math.round(LIVE_CAP_DEFAULT * Math.sqrt((deviceMemoryGb ?? 8) / 8))
  const byFreeHeap = freeHeapBytes === undefined ? 0 : Math.floor((freeHeapBytes * FREE_HEAP_SHARE) / LIVE_FRAME_HEAP_BYTES)
  // Free memory only ever raises the cap; a machine that is short of it is already on its device-sized floor.
  return clamp(Math.max(clamp(byDevice, LIVE_CAP_FLOOR, LIVE_CAP_DEFAULT), byFreeHeap), LIVE_CAP_FLOOR, LIVE_CAP_CEILING)
}

/** What this browser reports about memory. Every field is absent where the browser does not say. */
export function readLiveCapMemory(bridge: boolean): LiveCapMemory {
  const deviceMemoryGb = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const heap = typeof performance === 'undefined' ? undefined : (performance as Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } }).memory
  return {
    deviceMemoryGb,
    freeHeapBytes: heap ? Math.max(0, heap.jsHeapSizeLimit - heap.usedJSHeapSize) : undefined,
    bridge,
  }
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
  /** The frames that are live now: when more are in view than the cap, these keep their slots over equally-near newcomers. */
  retainedIds?: ReadonlySet<string>
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
      .sort((a, b) => rank(a, input.retainedIds) - rank(b, input.retainedIds))
    for (const frame of ranked.slice(0, cap)) live.set(frame.id, 'in-view')
  }
  return { cap, live }
}

function rank(frame: LiveFrameCandidate, retainedIds: ReadonlySet<string> | undefined): number {
  return frame.distanceToCenter - (retainedIds?.has(frame.id) ? RETAINED_BONUS_PX : 0)
}
