/**
 * Why one prop cannot be edited, or `undefined` when it can.
 *
 * Delegates the decision to `isPropWritableToSource` — the same predicate the
 * store's `updateNodeProps` guard uses — so the panel offers exactly the
 * controls the store will accept. When the two disagree the panel wins visually
 * and the store wins in fact, which is precisely the shape of "I typed and
 * nothing happened".
 *
 * The reason shown, in order:
 *
 *  1. **This prop's own resolution** (`PageNode.resolvedProps[propKey]`) — R2
 *     (`docs/audits/2026-08-06/09-refusal-states.md`): every code-valued prop
 *     now carries its OWN "value from …" sentence, not just the node's first.
 *  2. **The node's `lockReason`** — a STRUCTURAL phrase ("item 2 of DEALS")
 *     that applies to every prop on a locked node, when this prop has no
 *     resolution of its own (a `.map` row locks props the evaluator never
 *     touched at all, since one piece of source renders every row).
 *  3. **The generic `'set in code'` fallback** — a structured/JSX value, which
 *     carries no `Resolution` at all (see `tryResolvePropValue`'s doc comment).
 *
 * This lives in its own module rather than in `renderModuleTabContent.tsx`
 * because both that file and `InstanceCallSiteView.tsx` need it, and
 * `renderModuleTabContent` renders `InstanceCallSiteView` — importing the
 * helper back out of the renderer closed a real import cycle
 * (`no-circular-dependencies.test.ts`). A leaf with no panel imports of its own
 * keeps that graph one-directional, the same reasoning
 * `server/handlers/studio/projectProfileSchema.ts` uses on the server side.
 *
 * `src/core/page-tree/editConstraint.ts` builds the same fact as a typed
 * `EditConstraint` (reason + explanation + actions) for surfaces that need
 * more than a string — this function stays a thin, string-returning wrapper
 * so the two off-limits callers above (`InPlaceInspector.tsx`, canvas-owned;
 * `InstanceCallSiteView.tsx`, Component-section-owned) keep working unchanged.
 */
import { isPropWritableToSource } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'

export function propLockReason(node: PageNode, propKey: string): string | undefined {
  if (isPropWritableToSource(node, propKey)) return undefined
  const resolved = node.resolvedProps?.[propKey]
  if (resolved) return resolved.note ? `${resolved.source} — ${resolved.note}` : `value from ${resolved.source}`
  return node.lockReason ?? 'set in code'
}
