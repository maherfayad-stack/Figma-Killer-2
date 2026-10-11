/**
 * posterFillPlan (SB-5): which frame the background fill photographs next.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/posterFillPlan.ts
 */
import { describe, expect, it } from 'bun:test'
import { nextFillCandidate, type FillCandidate, type FillContext } from '@site/canvas/BoardFramesLayer/posterFillPlan'

function candidate(id: string, centerX: number, centerY = 0): FillCandidate {
  return { frameId: id, key: `${id}::k`, centerX, centerY }
}

function context(overrides: Partial<FillContext> = {}): FillContext {
  return {
    viewCenter: { x: 0, y: 0 },
    liveFrameIds: new Set(),
    hasPoster: () => false,
    failedKeys: new Set(),
    ...overrides,
  }
}

const board = [candidate('far', 5000), candidate('near', 100), candidate('mid', 1000)]

describe('nextFillCandidate', () => {
  it('takes the frame nearest the viewport centre first, so a zoom-out fills outward from where the user is', () => {
    expect(nextFillCandidate(board, context())?.frameId).toBe('near')
    expect(nextFillCandidate(board, context({ viewCenter: { x: 5000, y: 0 } }))?.frameId).toBe('far')
  })

  it('skips frames that already have a picture', () => {
    const next = nextFillCandidate(board, context({ hasPoster: (key) => key === 'near::k' }))
    expect(next?.frameId).toBe('mid')
  })

  it('skips live frames: they photograph themselves', () => {
    const next = nextFillCandidate(board, context({ liveFrameIds: new Set(['near', 'mid']) }))
    expect(next?.frameId).toBe('far')
  })

  it('never retries a key that produced no picture', () => {
    const next = nextFillCandidate(board, context({ failedKeys: new Set(['near::k', 'mid::k']) }))
    expect(next?.frameId).toBe('far')
  })

  it('is null once every frame is photographed, live or given up on', () => {
    expect(nextFillCandidate(board, context({ hasPoster: () => true }))).toBeNull()
    expect(nextFillCandidate([], context())).toBeNull()
  })
})
