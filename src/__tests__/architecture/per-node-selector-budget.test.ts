/**
 * Architecture Gate — the per-node canvas renderer's store-subscription budget.
 *
 * Zustand runs EVERY subscribed selector on EVERY `set()`. `NodeRenderer` is
 * mounted once per live canvas node, so its subscription count is a
 * multiplier on the whole board: at 800 live nodes, one extra
 * `useEditorStore(...)` in this file is 800 more selector invocations on every
 * keystroke, every click, every pan commit.
 *
 * That cost is invisible in review — each individual selector looks trivial —
 * which is why it gets a number instead of a convention. When a genuinely new
 * piece of per-node state is needed, the first questions are: can it be read
 * through `getState()` where it is used (an action, or a value constant for a
 * session), and can it be a KEYED read that wakes only the nodes whose answer
 * changed (`canvasNodeSelection.ts`, `canvasHover.ts`)? If it truly cannot,
 * raise the budget deliberately, in the same commit, with a note here.
 *
 * The count is of DIRECT `useEditorStore(` calls — the reactive hook form.
 * `useEditorStore.getState()` is an imperative one-off read from an event
 * handler and subscribes to nothing, so it is excluded.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')

/**
 * Current: 7. History: 13 → 11 when the `activeInlineEdit` triple was
 * collapsed into one `useShallow`; 11 → 7 in P2-I (PERF-1), which moved hover
 * off the store (`canvasHover.ts` — the per-node hover read fed a dead
 * `data-hovered`), made the selection a keyed read (`canvasNodeSelection.ts`),
 * read the three inline-edit actions through `getState()`, and replaced both
 * `useShallow` object selectors with primitives. Measured with
 * `bun run bench:editor-store`'s subscriber sweep (the P2-I PR has the table).
 * Raise ONLY with a measurement showing the new subscription cannot ride an
 * existing one.
 */
const NODE_RENDERER_SUBSCRIPTION_BUDGET = 7

function countReactiveSubscriptions(source: string): number {
  // `useEditorStore(` but not `useEditorStore.getState(`.
  return source.match(/useEditorStore\(/g)?.length ?? 0
}

describe('per-node selector budget', () => {
  const source = readFileSync(join(SRC_ROOT, 'admin/pages/site/canvas/NodeRenderer.tsx'), 'utf8')

  it('NodeRenderer stays within its store-subscription budget', () => {
    const count = countReactiveSubscriptions(source)

    expect(count).toBeLessThanOrEqual(NODE_RENDERER_SUBSCRIPTION_BUDGET)
    // Pinned from below too: if a refactor removes subscriptions, LOWER the
    // budget in the same commit so the gate keeps its teeth.
    expect(count).toBe(NODE_RENDERER_SUBSCRIPTION_BUDGET)
  })

  it('NodeRenderer has no object-returning (useShallow) selector', () => {
    // An object selector allocates per node per store change and then
    // shallow-compares it: the two NodeRenderer had were ~45% of the whole
    // canvas sweep (`01-perf.md` §1). Every per-node read returns a primitive
    // or an existing reference.
    expect(/\buseShallow\s*\(|zustand\/react\/shallow/.test(source)).toBe(false)
  })
})
