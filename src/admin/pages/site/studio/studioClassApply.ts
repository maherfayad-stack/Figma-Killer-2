/**
 * studioClassApply - "apply this theme value by its utility class" (CT-6).
 *
 * A value a Tailwind v3 config or a `theme.ts` defines has no CSS variable to
 * point a property at, and Studio never rewrites the file that defines it. What
 * it CAN do, honestly and in exactly one place per element, is what the author
 * would type: add `bg-primary` to the element's `className`. That is the
 * existing class codemod (`setJsxClassName`, a `kind: 'class'` edit with a
 * literal token), so every one of its refusals (a spread `className`, a dynamic
 * template, a shared component's call site) arrives as the engine's usual
 * warning with the server's sentence, and nothing is written.
 *
 * One commit for the whole selection, and one undo entry: the edit is marked
 * `restyle` (CT-5), which journals the batch and makes it all-or-nothing, because
 * whether the class was already on an element is something only the source
 * knows - an inverse "remove the class" would take away one the author had put
 * there. The journal puts every file back byte for byte instead.
 */
import { commitStructural } from './studioStructuralCommitEngine'

/** Adds the class `token` to each element in `nodeIds`, as one write with one undo entry; resolves to whether the write landed (a refusal is the engine's own warning). */
export async function commitStudioApplyClass(nodeIds: readonly string[], token: string): Promise<boolean> {
  if (nodeIds.length === 0) return false
  let landed = false
  await commitStructural(
    nodeIds.map((nodeId) => ({ kind: 'class', nodeId, add: [{ kind: 'literal', token }], remove: [], restyle: true })),
    'Could not apply the class',
    { undo: { label: `Apply ${token}`, template: { kind: 'restore-journal' } }, onLanded: () => { landed = true } },
  )
  return landed
}
