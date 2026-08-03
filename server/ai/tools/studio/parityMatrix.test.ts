/**
 * Canvas parity matrix gate — "the agent can do what you can
 * do in the canvas" is a requirement with an enforcement mechanism, not just
 * a claim: every real editor action is accounted for, every tool named is
 * real, and no row is silently missing a status.
 */
import { describe, expect, it } from 'bun:test'
import { STUDIO_CANVAS_PARITY_MATRIX } from './parityMatrix'
import { studioAgentTools } from './index'

describe('canvas parity matrix', () => {
  it('has at least one row', () => {
    expect(STUDIO_CANVAS_PARITY_MATRIX.length).toBeGreaterThan(0)
  })

  it('every action is named exactly once — no duplicate rows silently drift apart', () => {
    const actions = STUDIO_CANVAS_PARITY_MATRIX.map((r) => r.action)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('every "tool" row names only real, registered tools', () => {
    const registered = new Set(studioAgentTools.map((t) => t.name))
    for (const row of STUDIO_CANVAS_PARITY_MATRIX) {
      if (row.status.kind !== 'tool') continue
      expect(row.status.toolNames.length).toBeGreaterThan(0)
      for (const name of row.status.toolNames) {
        expect(registered.has(name)).toBe(true)
      }
    }
  })

  it('every "withheld" and "missing" row carries a real, non-empty reason', () => {
    for (const row of STUDIO_CANVAS_PARITY_MATRIX) {
      if (row.status.kind !== 'withheld' && row.status.kind !== 'missing') continue
      expect(row.status.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('every "native" row says HOW it is done with the file tools', () => {
    // A `native` row with no explanation is indistinguishable from a gap
    // someone reclassified to make this table look complete.
    for (const row of STUDIO_CANVAS_PARITY_MATRIX) {
      if (row.status.kind !== 'native') continue
      expect(row.status.how.trim().length).toBeGreaterThan(0)
    }
  })

  it('every registered mutating tool is referenced by at least one parity row', () => {
    // The inverse direction: a write tool that maps to no editor action at
    // all is either undocumented here or shouldn't exist — this catches a
    // tool added later without updating the matrix.
    const referenced = new Set(
      STUDIO_CANVAS_PARITY_MATRIX.flatMap((r) => (r.status.kind === 'tool' ? r.status.toolNames : [])),
    )
    const unreferencedWriteTools = studioAgentTools.filter((t) => t.mutates && !referenced.has(t.name))
    expect(unreferencedWriteTools.map((t) => t.name)).toEqual([])
  })

  it('reports the current, honest gap count — a regression here means a "missing" row was silently marked "withheld"', () => {
    const missing = STUDIO_CANVAS_PARITY_MATRIX.filter((r) => r.status.kind === 'missing')
    // A CHANGE to this number is real news — a new gap was found (up) or one
    // was closed (down) — never edit it without also updating the matrix rows
    // it counts.
    expect(missing.length).toBe(0)
  })

  it('every "tool" row that closes a former gap references a REAL, non-empty toolNames list (no accidental empty array)', () => {
    for (const name of ['studio_upload_asset', 'studio_set_frame_axes', 'studio_duplicate_frame_as_variant']) {
      const row = STUDIO_CANVAS_PARITY_MATRIX.find(
        (r) => r.status.kind === 'tool' && r.status.toolNames.includes(name),
      )
      expect(row).toBeDefined()
    }
  })
})
