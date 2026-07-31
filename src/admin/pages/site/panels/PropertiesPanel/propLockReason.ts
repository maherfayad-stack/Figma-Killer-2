/**
 * Why one prop cannot be edited, or `undefined` when it can.
 *
 * Delegates the decision to `isPropWritableToSource` — the same predicate the
 * store's `updateNodeProps` guard uses — so the panel offers exactly the
 * controls the store will accept. When the two disagree the panel wins visually
 * and the store wins in fact, which is precisely the shape of "I typed and
 * nothing happened".
 *
 * The reason shown is the node's `lockReason` when it has one, because the
 * parser writes that phrase to be read by a person ("item 2 of DEALS"). That
 * phrase is STRUCTURAL and applies to every prop on such a node. Most
 * code-valued props sit on a node with no structural lock at all — one resolved
 * attribute among literals — and get the generic fallback rather than the
 * node's first resolution, which may well have been a different prop's
 * (`ParsedNode.resolution` keeps only the first).
 *
 * This lives in its own module rather than in `renderModuleTabContent.tsx`
 * because both that file and `InstanceCallSiteView.tsx` need it, and
 * `renderModuleTabContent` renders `InstanceCallSiteView` — importing the
 * helper back out of the renderer closed a real import cycle
 * (`no-circular-dependencies.test.ts`). A leaf with no panel imports of its own
 * keeps that graph one-directional, the same reasoning
 * `server/handlers/studio/projectProfileSchema.ts` uses on the server side.
 */
import { isPropWritableToSource } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'

export function propLockReason(node: PageNode, propKey: string): string | undefined {
  if (isPropWritableToSource(node, propKey)) return undefined
  return node.lockReason ?? 'set in code'
}
