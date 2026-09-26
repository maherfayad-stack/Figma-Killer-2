/**
 * studioEditPositions — where the elements a save batch CREATED or MOVED
 * ended up, as node ids the parser will mint for them on the next read
 * (`store-13`/`store-14`). Split out of `studioWriteback.ts` (the
 * `module-size-budgets` ceiling) because it is one self-contained idea with
 * one reason to change: the coordinate a created/relocated element is pinned
 * to while later edits in the same batch are still shifting its file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { buildSourceNodeId } from '@core/page-tree'
import { studioEditFile, studioEditLocation, type SourceTargetScope } from './studioEditRouting'

/** Lines in `file`, or 0 when it does not exist — the one reading every line-count comparison here uses. */
export function countLines(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0
}

/**
 * `store-13` — one element a batch created, pinned to a coordinate that later
 * edits in the same batch cannot invalidate.
 *
 * `linesFromEnd` is the file's line count at the moment this edit finished,
 * minus the created element's line. `orderStudioEditsForApply` applies a batch
 * BOTTOM-TO-TOP, so every edit that runs after this one sits strictly ABOVE
 * the element just created: it can only add or remove lines before it, which
 * moves the element's absolute line and leaves its distance from the end of
 * the file exactly as it was. Recording the absolute line instead would report
 * a stale position for every created element but the last — reachable today
 * with a multi-selection ⌘D.
 */
export interface CreatedNodePosition {
  /** Workspace-relative POSIX path — the head of the node id. */
  rel: string
  /** Absolute path, for the final line count. */
  file: string
  col: number
  linesFromEnd: number
}

/** Pin one `created` location to the file it landed in. Skips an edit whose id no longer decodes — there is no honest node id to mint from it. */
export function recordCreatedPosition(
  into: CreatedNodePosition[],
  dir: string,
  nodeId: string,
  created: { line: number; col: number },
  scope?: SourceTargetScope,
): void {
  const location = studioEditLocation(dir, nodeId, scope)
  const file = studioEditFile(dir, nodeId, scope)
  if (!location || !file) return
  into.push({ rel: location.rel, file, col: created.col, linesFromEnd: countLines(file) - created.line })
}

/**
 * The created elements' node ids, re-derived against the file as the WHOLE
 * batch left it — the plain `rel:line:col` the parser will mint for the same
 * element on its next read (`buildSourceNodeId`, so this cannot drift from the
 * parser's own spelling).
 *
 * A file missing from `lineCountAfter` never happens for a created element (it
 * was written, so it is in `touchedFiles`), but is skipped rather than guessed.
 */
export function resolveCreatedNodeIds(
  positions: readonly CreatedNodePosition[],
  lineCountAfter: ReadonlyMap<string, number>,
): string[] {
  const ids: string[] = []
  for (const position of positions) {
    const after = lineCountAfter.get(position.file)
    if (after === undefined) continue
    ids.push(buildSourceNodeId(position.rel, after - position.linesFromEnd, position.col))
  }
  return ids
}
