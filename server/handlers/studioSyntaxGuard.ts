/**
 * studioSyntaxGuard — WB-24: no write lands in a file that does not parse.
 *
 * TypeScript's parser recovers a tree from a broken file instead of giving up,
 * and every codemod here locates its target in that tree. In a file with an
 * unclosed `<p>`, the element at `line:col` is whatever the recovery guessed —
 * so a write there has no honest target, and any bytes it splices go into a
 * file that is already broken, somewhere the user did not choose. The only
 * safe answer is the one the load already gives (`loadWarnings.ts` flags the
 * page): refuse, name the line, and let the user fix it in code.
 *
 * One guard per batch. `applyStudioEditBatch` asks it before each edit; it
 * reads each file the batch would write at most once, BEFORE the first write
 * to it lands (a file that was broken at the start of the batch is never
 * written by it, so the answer cannot change under the batch).
 */
import { join } from 'node:path'
import { fileSyntaxError, type SourceSyntaxError } from '@core/page-parser'
import { canonicalSourceRel, studioEditLocation } from './studioEditRouting'
import type { StudioEdit, StudioEditRefusal } from './studioEditSchemas'

/**
 * Every source file `edit` would write, workspace-relative — its own target,
 * plus the second file a transplant or a stylesheet `create` touches. Decoded
 * through `studioEditLocation`, the same containment-checked decoder the write
 * itself uses, so this never reads a path the write would not.
 */
function filesWrittenBy(dir: string, edit: StudioEdit): string[] {
  const rels: string[] = []
  const own = studioEditLocation(dir, edit.nodeId)
  if (own) rels.push(own.rel)
  if (edit.kind === 'transplant') {
    const destination = studioEditLocation(dir, edit.parentNodeId)
    if (destination) rels.push(destination.rel)
  }
  // A `create` writes the new stylesheet's `import` into the page — the
  // stylesheet itself is CSS, which this guard has no business parsing.
  // `pageFile` arrives as a bare path, so it goes through the same guard a
  // node id's `rel` does before anything reads it.
  if (edit.kind === 'css' && edit.op === 'create') {
    const page = canonicalSourceRel(dir, edit.pageFile)
    if (page) rels.push(page)
  }
  return rels
}

/**
 * A guard for one batch in `dir`: `null` when every file `edit` would write
 * parses, otherwise the `syntax-error` refusal naming the first broken file
 * and its first parse error's line.
 */
export function createSyntaxGuard(dir: string): (edit: StudioEdit) => StudioEditRefusal | null {
  const checked = new Map<string, SourceSyntaxError | undefined>()
  const errorIn = (rel: string): SourceSyntaxError | undefined => {
    if (!checked.has(rel)) checked.set(rel, fileSyntaxError(join(dir, ...rel.split('/'))))
    return checked.get(rel)
  }

  return (edit) => {
    for (const rel of filesWrittenBy(dir, edit)) {
      const error = errorIn(rel)
      if (!error) continue
      return {
        nodeId: edit.nodeId,
        kind: edit.kind,
        reason: 'syntax-error',
        message:
          `${rel} does not parse — line ${error.line}: ${error.message} Studio will not write into a file ` +
          'it cannot read reliably. Fix that line in code, and the edit can be made again.',
      }
    }
    return null
  }
}
