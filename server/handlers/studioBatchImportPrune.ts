/**
 * studioBatchImportPrune — the import pass every edit batch runs around its
 * writes: which bindings the files it REMOVES markup from reference before
 * anything is written, and which of those are dead once every edit has landed.
 *
 * Removing markup can be the last use of an import, and under
 * `noUnusedLocals` leaving that behind is a build failure in the user's repo,
 * so the binding has to go too. Snapshotted BEFORE the batch and pruned AFTER
 * it, because an import lives at the TOP of a file: cutting its line mid-batch
 * would shift the pending `line:col` of every edit still queued below it,
 * which is the exact hazard `orderStudioEditsForApply` exists to prevent.
 * Waiting also makes the question answerable at all: a binding used by two
 * elements deleted in the same batch is orphaned by neither one alone.
 *
 * Only a binding that was live before and is dead after is pruned. An import
 * the user had already left unused is their line, not something this batch
 * created.
 *
 * Scoped to the edits that actually remove markup, and to the files they
 * name. Every other kind either cannot drop the last reference to a binding or
 * already retires its own (`swap`, and `insertJsxIntoSlotProp` for a slot
 * replace), and this pass costs two extra parses per file, which is not
 * something to spend on every keystroke-driven save.
 *
 * Split out of `studioWriteback.ts` at the module-size gate.
 */
import { existsSync } from 'node:fs'
import { createImportPruneSession, isPrunableSourceFile } from '@core/ast-codemods'
import { studioEditFile, type SourceTargetScope } from './studioEditRouting'
import type { StudioEdit } from './studioEditSchemas'

/**
 * The kinds whose write can remove the last use of an import in the file they
 * name:
 * - `delete`;
 * - a transplant or canvas-layer lift that MOVES (not copies) markup out of
 *   its origin file (D2 G3). The destination is deliberately not snapshotted:
 *   the codemod just added imports to it, and pruning a binding that has no
 *   reference yet would delete the one it wrote;
 * - `ungroup` (`store-14`): dissolving a container can be the last use of the
 *   binding that named it, and it is what makes ⌘G → ⌘Z byte-exact;
 * - `detach` (P3-D): it replaces the call site, and hands the component's
 *   import to this pass, which knows what the rest of the batch removed too.
 */
function removesMarkup(edit: StudioEdit): boolean {
  return (
    edit.kind === 'delete' ||
    edit.kind === 'ungroup' ||
    edit.kind === 'detach' ||
    // OD-8 — a removed array element can be the last reader of an import (`{ icon: HomeIcon }`).
    (edit.kind === 'list-item' && edit.op.kind === 'remove') ||
    ((edit.kind === 'transplant' || edit.kind === 'canvas-layer-lift') && edit.copy !== true)
  )
}

/**
 * Snapshot, before a batch writes a byte, the bindings each file its
 * markup-removing edits name references. `prune()` runs after the last edit.
 */
export function snapshotImportsBeforeRemoval(
  dir: string,
  edits: readonly StudioEdit[],
  scope: SourceTargetScope,
): { prune: () => void } {
  const session = createImportPruneSession()
  const referencedBefore = new Map<string, ReadonlySet<string>>()
  for (const edit of edits) {
    if (!removesMarkup(edit)) continue
    const file = studioEditFile(dir, edit.nodeId, scope)
    if (!file || referencedBefore.has(file)) continue
    if (isPrunableSourceFile(file) && existsSync(file)) referencedBefore.set(file, session.snapshot(file))
  }
  return {
    prune: () => {
      for (const [file, wasReferenced] of referencedBefore) {
        if (existsSync(file)) session.prune(file, wasReferenced)
      }
    },
  }
}
