/**
 * `studio.slot` renders ZERO DOM elements of its own — the whole reason this
 * module exists instead of a `<div>` wrapper around a fragment's captured
 * children (trap #1, `PROJECT-BRIEF.md` §6 — a wrapper here corrupts every
 * measurement/drop-target/fidelity comparison downstream). Scoped to the
 * component directly (not the full canvas/store, which `src/__tests__/canvas/
 * instanceNodes.test.tsx` already exercises for the sibling `studio.instance`
 * module) so this stays a fast, dependency-free unit test.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { SlotEditor } from '../SlotEditor'

afterEach(cleanup)

describe('studio.slot — zero-DOM fragment node', () => {
  it('renders exactly its children, with no wrapper element', () => {
    const { container } = render(
      <SlotEditor props={{}} nodeId="slot1" isSelected={false}>
        <span data-testid="a">A</span>
        <span data-testid="b">B</span>
      </SlotEditor>,
    )

    // `container` is the render root itself — if `SlotEditor` produced a
    // wrapper element, `container.children` would be ONE element (the
    // wrapper), not the two children rendered directly into it.
    expect(container.children.length).toBe(2)
    expect(container.querySelector('[data-testid="a"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="b"]')).not.toBeNull()
  })

  it('renders nothing at all when it has no children', () => {
    const { container } = render(<SlotEditor props={{}} nodeId="slot1" isSelected={false} />)

    expect(container.children.length).toBe(0)
  })
})
