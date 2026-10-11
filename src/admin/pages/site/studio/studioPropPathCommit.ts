/**
 * studioPropPathCommit - one literal inside a call site's inline list or object
 * (`segmentedControl={{ items, value: 0 }}` -> `value: 1`, a chip's
 * `selected`), written through the structural commit engine.
 *
 * The autosave diff (`nodeDiffWriteback.ts`) only reads scalar props, so a leaf
 * inside a list never reaches it; this is the explicit write. It is one
 * `prop` edit with a `path` (`setJsxPropPath`), journaled on the server like
 * every one-shot rewrite, so the gesture's Undo is the journal's `restore`:
 * the file back byte for byte, whether the write replaced a literal or
 * appended a key.
 */
import { commitStructural } from './studioStructuralCommitEngine'

export interface PropPathCommit {
  /** The element whose attribute holds the list or object - an instance's own id for a call-site prop. */
  nodeId: string
  /** The attribute name (not the `callSiteProps:` key). */
  prop: string
  /** Where inside the attribute's value. */
  path: readonly (string | number)[]
  value: string | number | boolean
}

export async function commitStudioPropPath(commit: PropPathCommit): Promise<void> {
  const where = [commit.prop, ...commit.path.map((segment) => String(segment))].join('.')
  await commitStructural(
    [{ kind: 'prop', nodeId: commit.nodeId, prop: commit.prop, path: [...commit.path], value: commit.value }],
    'Edit refused',
    { undo: { label: `Set ${where}`, template: { kind: 'restore-journal' } } },
  )
}
