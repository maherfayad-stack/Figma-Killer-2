/**
 * The agent gate — the policy half of anchoring, kept with the feature whose
 * policy it is. The confidences themselves are asserted in
 * `@core/studio-anchor`'s `resolve.test.ts`.
 */
import { describe, it, expect } from 'bun:test'
import { explainAnchorRefusal, isAgentActionable } from '../agentGate'

describe('the agent gate', () => {
  it('lets the agent act only on an anchor it is sure about', () => {
    expect(isAgentActionable('exact')).toBe(true)
    expect(isAgentActionable('moved')).toBe(true)
    // Nothing could have gone stale on a pin that never named an element.
    expect(isAgentActionable('unanchored')).toBe(true)
    // These two are the whole reason the gate exists: acting here edits the
    // wrong element in the user's real source.
    expect(isAgentActionable('drifted')).toBe(false)
    expect(isAgentActionable('detached')).toBe(false)
  })

  it('has a reason to post for every refusal, and none for a pass', () => {
    expect(explainAnchorRefusal('exact')).toBeNull()
    expect(explainAnchorRefusal('moved')).toBeNull()
    expect(explainAnchorRefusal('drifted')).toContain('edited')
    expect(explainAnchorRefusal('detached')).toContain('no longer exists')
  })
})
