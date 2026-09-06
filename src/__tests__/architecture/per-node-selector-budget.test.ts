/**
 * Architecture Gate — the per-node canvas renderer's store-subscription budget.
 *
 * Zustand runs EVERY subscribed selector on EVERY `set()`. `NodeRenderer` is
 * mounted once per live canvas node, so its subscription count is a
 * multiplier on the whole board: at 800 live nodes, one extra
 * `useEditorStore(...)` in this file is 800 more selector invocations on every
 * keystroke, every hover, every pan commit.
 *
 * That cost is invisible in review — each individual selector looks trivial —
 * which is why it gets a number instead of a convention. When a genuinely new
 * piece of per-node state is needed, the first question is whether it can join
 * an EXISTING subscription (the three `activeInlineEdit` reads were collapsed
 * into one `useShallow` subscription for exactly this reason). If it truly
 * cannot, raise the budget deliberately, in the same commit, with a note here.
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
 * Current: 11 (was 13 before the `activeInlineEdit` triple was collapsed).
 * Raise ONLY with a measurement showing the new subscription cannot ride an
 * existing one.
 */
const NODE_RENDERER_SUBSCRIPTION_BUDGET = 11

function countReactiveSubscriptions(source: string): number {
  // `useEditorStore(` but not `useEditorStore.getState(`.
  return source.match(/useEditorStore\(/g)?.length ?? 0
}

describe('per-node selector budget', () => {
  it('NodeRenderer stays within its store-subscription budget', () => {
    const source = readFileSync(join(SRC_ROOT, 'admin/pages/site/canvas/NodeRenderer.tsx'), 'utf8')
    const count = countReactiveSubscriptions(source)

    expect(count).toBeLessThanOrEqual(NODE_RENDERER_SUBSCRIPTION_BUDGET)
    // Pinned from below too: if a refactor removes subscriptions, LOWER the
    // budget in the same commit so the gate keeps its teeth.
    expect(count).toBe(NODE_RENDERER_SUBSCRIPTION_BUDGET)
  })
})
