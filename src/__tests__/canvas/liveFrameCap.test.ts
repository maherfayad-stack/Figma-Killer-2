/**
 * liveFrameCap (SB-2) — owner decision 2026-10-10: the live-frame cap is
 * adaptive, default 20, scaling up with memory, never below 12; screens beyond
 * it or below zoom 0.35 are posters; working frames are always live.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/liveFrameCap.ts
 */
import { describe, expect, it } from 'bun:test'
import {
  computeLiveFrameCap,
  LIVE_CAP_BRIDGE,
  LIVE_CAP_CEILING,
  LIVE_CAP_DEFAULT,
  LIVE_CAP_FLOOR,
  POSTER_ZOOM,
  selectLiveFrames,
  type LiveFrameCandidate,
} from '@site/canvas/BoardFramesLayer/liveFrameCap'

const GB = 1024 ** 3
const MB = 1024 * 1024

describe('computeLiveFrameCap', () => {
  it('defaults to 20 with nothing reported', () => {
    expect(computeLiveFrameCap({})).toBe(LIVE_CAP_DEFAULT)
    expect(LIVE_CAP_DEFAULT).toBe(20)
  })

  it('scales the default down with a small device, never below 12', () => {
    expect(computeLiveFrameCap({ deviceMemoryGb: 4 })).toBeLessThan(LIVE_CAP_DEFAULT)
    expect(computeLiveFrameCap({ deviceMemoryGb: 4 })).toBeGreaterThanOrEqual(LIVE_CAP_FLOOR)
    expect(computeLiveFrameCap({ deviceMemoryGb: 0.25 })).toBe(LIVE_CAP_FLOOR)
  })

  it('rises above 20 with plenty of free heap, bounded by the ceiling', () => {
    // 3 GB free * 5% = 154 MB; at 8 MB a frame that is 19 -> the default still wins.
    expect(computeLiveFrameCap({ deviceMemoryGb: 8, freeHeapBytes: 3 * GB })).toBe(LIVE_CAP_DEFAULT)
    // 8 GB free * 5% = 410 MB = 51 frames -> the ceiling.
    expect(computeLiveFrameCap({ deviceMemoryGb: 8, freeHeapBytes: 8 * GB })).toBe(LIVE_CAP_CEILING)
    expect(computeLiveFrameCap({ deviceMemoryGb: 8, freeHeapBytes: 5 * GB })).toBeGreaterThan(LIVE_CAP_DEFAULT)
  })

  it('never falls below the device-sized cap because the heap is busy', () => {
    expect(computeLiveFrameCap({ deviceMemoryGb: 8, freeHeapBytes: 50 * MB })).toBe(LIVE_CAP_DEFAULT)
    expect(computeLiveFrameCap({ deviceMemoryGb: 1, freeHeapBytes: 0 })).toBe(LIVE_CAP_FLOOR)
  })

  it('a bridge board has its own cap, below the floor, whatever the memory', () => {
    expect(computeLiveFrameCap({ bridge: true })).toBe(LIVE_CAP_BRIDGE)
    expect(computeLiveFrameCap({ bridge: true, deviceMemoryGb: 8, freeHeapBytes: 8 * GB })).toBe(LIVE_CAP_BRIDGE)
  })
})

function frames(count: number, inView = true): LiveFrameCandidate[] {
  return Array.from({ length: count }, (_, i) => ({ id: `f${i}`, inView, distanceToCenter: i * 100 }))
}

const base = { zoom: 1, selectedFrameIds: new Set<string>(), editingFrameId: null, playFrameId: null }

describe('selectLiveFrames', () => {
  it('lives the nearest `cap` in-view frames and posters the rest', () => {
    const { live, cap } = selectLiveFrames({ ...base, frames: frames(100) })
    expect(cap).toBe(20)
    expect(live.size).toBe(20)
    expect([...live.keys()].slice(0, 3)).toEqual(['f0', 'f1', 'f2'])
    expect(live.has('f20')).toBe(false)
  })

  it('frames outside the viewport are posters however few there are', () => {
    const { live } = selectLiveFrames({ ...base, frames: frames(5, false) })
    expect(live.size).toBe(0)
  })

  it('below zoom 0.35 only working frames stay live', () => {
    const { live } = selectLiveFrames({
      ...base,
      zoom: POSTER_ZOOM - 0.01,
      frames: frames(30),
      selectedFrameIds: new Set(['f25']),
    })
    expect([...live.keys()]).toEqual(['f25'])
    expect(selectLiveFrames({ ...base, zoom: POSTER_ZOOM, frames: frames(30) }).live.size).toBe(20)
  })

  it('working frames are live beyond the cap, out of view and below the poster zoom; they do not use up the cap', () => {
    const all = frames(60)
    const { live } = selectLiveFrames({
      ...base,
      zoom: 1,
      frames: all,
      selectedFrameIds: new Set(['f50']),
      editingFrameId: 'f55',
      playFrameId: 'f59',
    })
    expect(live.get('f59')).toBe('play')
    expect(live.get('f55')).toBe('editing')
    expect(live.get('f50')).toBe('selected')
    expect([...live.values()].filter((reason) => reason === 'in-view').length).toBe(20)
  })

  it('editing a poster frame promotes it: it is live the moment it is the editing frame', () => {
    const all = frames(40)
    expect(selectLiveFrames({ ...base, frames: all }).live.has('f39')).toBe(false)
    expect(selectLiveFrames({ ...base, frames: all, editingFrameId: 'f39' }).live.has('f39')).toBe(true)
  })

  it('ignores working ids that are not frames of this board', () => {
    const { live } = selectLiveFrames({ ...base, frames: frames(2), editingFrameId: 'gone', selectedFrameIds: new Set(['gone']) })
    expect(live.has('gone')).toBe(false)
  })

  it('frames that are already live keep their slot over an equally-near newcomer, so a pan does not swap equals', () => {
    const near = [
      { id: 'a', inView: true, distanceToCenter: 100 },
      { id: 'b', inView: true, distanceToCenter: 110 },
    ]
    const bridge = { bridge: true as const }
    // Cap of 8 on a bridge board: nine candidates, one must lose.
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, inView: true, distanceToCenter: 1000 + i }))
    const fresh = selectLiveFrames({ ...base, ...bridge, frames: [...nine, ...near.map((f) => ({ ...f, id: `x${f.id}` }))] })
    expect(fresh.live.size).toBe(LIVE_CAP_BRIDGE)
    // n8 is the farthest, but it was live: it outranks a newcomer within the bonus.
    const frames = [...nine.slice(0, 8), { id: 'n8', inView: true, distanceToCenter: 1100 }, { id: 'new', inView: true, distanceToCenter: 1090 }]
    expect(selectLiveFrames({ ...base, ...bridge, frames }).live.has('n8')).toBe(false)
    expect(selectLiveFrames({ ...base, ...bridge, frames, retainedIds: new Set(['n8']) }).live.has('n8')).toBe(true)
  })
})
