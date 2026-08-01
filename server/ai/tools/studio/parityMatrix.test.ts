/**
 * Canvas parity matrix gate (WS-12 §6.1/§9) — "the agent can do what you can
 * do in the canvas" is a requirement with an enforcement mechanism, not just
 * a claim: every real editor action is accounted for, every tool named is
 * real, and no row is silently missing a status.
 */
import { describe, expect, it } from 'bun:test'
import { STUDIO_CANVAS_PARITY_MATRIX } from './parityMatrix'
import { studioAgentTools } from './index'

describe('canvas parity matrix (WS-12 §6.1)', () => {
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
      if (row.status.kind === 'tool') continue
      expect(row.status.reason.trim().length).toBeGreaterThan(0)
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
    // Exactly the three confirmed-against-code gaps as of WS-12 steps 5+6:
    // asset upload, per-frame preview axes, frame-as-variant duplication.
    // A CHANGE to this number (up or down) is real news — either a new gap
    // was found, or one was closed — never edit this number without also
    // updating the matrix rows it counts.
    expect(missing.length).toBe(3)
  })
})
