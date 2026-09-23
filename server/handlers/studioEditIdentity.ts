/**
 * studioEditIdentity — the element identity guard (P1-A, closes WB-1's guard
 * half and ERR-4's server half).
 *
 * A node id is a POSITION (`rel:line:col`). Before this guard every codemod
 * wrote to whatever sat at that position, so an edit whose file had changed
 * since the board read it — the agent's own Edit tool, VS Code, `git pull`, a
 * structural write still in flight — landed on a NEIGHBOUR and reported
 * `written: 1`. Measured: a prop and a text edit on `<li title="b">Two</li>`
 * rewrote the previous sibling; a delete removed "Zero" instead of "One".
 *
 * The client now sends, with every batch, the fingerprint the parser recorded
 * for each id it names (`expect`, keyed by node id — `@core/page-tree`'s
 * `SourceFingerprintExpectations`). This module answers two questions about
 * that, and nothing else:
 *
 *   - {@link findMovedEdits}: BEFORE any byte of the batch is written, which
 *     edits name an id whose position now holds something else? Those refuse
 *     `element-moved` and never reach a codemod. Checked against the files as
 *     they are before the batch, because that is the state the expectations
 *     describe — a batch applies bottom-to-top, and a prop edit and a style
 *     edit on ONE element would otherwise see each other's change as a move.
 *   - {@link fingerprintAfterWrite}: after a VALUE edit lands, what is the
 *     element's identity now? A prop, style, class, tag or text write changes
 *     the very bytes the fingerprint covers, and the board does not re-read a
 *     file after a write that shifted nothing — so without this answer its next
 *     edit to the same element would be refused as "moved" by Studio's own
 *     previous write.
 *
 * An id with no expectation is not checked: the guard is opt-in per id, so an
 * agent batch that sends none behaves exactly as before, and a write aimed at
 * a node the parser could not fingerprint (a `.map` row has no writable id at
 * all) is not refused for lacking one.
 *
 * P1-D builds on this: re-locating an edit through a line diff is "find the one
 * position in the current file whose fingerprint equals the expectation" —
 * the same `readSourceFingerprintAt` comparison, run over candidates.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceFile } from 'ts-morph'
import { createProject, loadSourceFile, readSourceFingerprintAt } from '@core/ast-codemods'
import { LITERAL_FINGERPRINT_LABEL } from '@core/page-parser'
import { ELEMENT_MOVED_REASON, sourceFingerprintLabel, type SourceFingerprintExpectations } from '@core/page-tree'
import { studioEditLocation } from './studioEditRouting'
import type { StudioEdit, StudioEditRefusal } from './studioEditSchemas'

/**
 * Every node id `edit` names — the element it writes, plus the anchor, the
 * destination container and a group's other members. Each one is a position
 * the write depends on, so each is checked when the client sent an
 * expectation for it. A `css` edit names a FILE + SELECTOR, never a node.
 */
export function editNamedNodeIds(edit: StudioEdit): string[] {
  if (edit.kind === 'css') return []
  return [
    edit.nodeId,
    ...('anchorNodeId' in edit && edit.anchorNodeId ? [edit.anchorNodeId] : []),
    ...('parentNodeId' in edit && edit.parentNodeId ? [edit.parentNodeId] : []),
    ...('siblingNodeIds' in edit ? edit.siblingNodeIds : []),
  ]
}

/**
 * The edits in `edits` that must NOT run, each with its `element-moved`
 * refusal. Reads each named file once, before anything in the batch writes.
 */
export function findMovedEdits(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations,
): Map<StudioEdit, StudioEditRefusal> {
  const moved = new Map<StudioEdit, StudioEditRefusal>()
  if (Object.keys(expect).length === 0) return moved
  const project = createProject()
  const files = new Map<string, SourceFile | null>()
  const readFile = (file: string): SourceFile | null => {
    if (!files.has(file)) files.set(file, existsSync(file) ? loadSourceFile(project, file) : null)
    return files.get(file)!
  }
  for (const edit of edits) {
    for (const nodeId of editNamedNodeIds(edit)) {
      const expected = expect[nodeId]
      if (expected === undefined) continue
      const location = studioEditLocation(dir, nodeId)
      if (!location) continue // synthetic, or refused by the path guard — the codemod path answers that
      const sourceFile = readFile(join(dir, location.rel))
      const actual = sourceFile ? readSourceFingerprintAt(sourceFile, location.line, location.col) : undefined
      if (actual === expected) continue
      moved.set(edit, {
        nodeId: edit.nodeId,
        kind: edit.kind,
        reason: ELEMENT_MOVED_REASON,
        message: movedMessage(location.rel, location.line, expected, actual),
      })
      break
    }
  }
  return moved
}

/** The edit kinds whose write changes the bytes a fingerprint covers without moving the target — see this module's doc. */
const IDENTITY_CHANGING_VALUE_KINDS = new Set<StudioEdit['kind']>(['prop', 'text', 'style', 'class', 'tag', 'literal', 'asset'])

/**
 * The target's fingerprint right after `edit` wrote it, or `null` for a kind
 * whose write re-reads the board anyway (structural, detach, swap, slot, css,
 * styled) or a target that no longer decodes.
 *
 * Measured immediately after THIS edit, before any edit above it in the batch
 * runs: the batch applies bottom-to-top, so the target is still at its
 * original `line:col` here even when a later edit will shift it — and the
 * original id is the key the client holds.
 */
export function fingerprintAfterWrite(dir: string, edit: StudioEdit): { nodeId: string; fingerprint: string } | null {
  if (!IDENTITY_CHANGING_VALUE_KINDS.has(edit.kind)) return null
  const location = studioEditLocation(dir, edit.nodeId)
  if (!location) return null
  const file = join(dir, location.rel)
  if (!existsSync(file)) return null
  const fingerprint = readSourceFingerprintAt(loadSourceFile(createProject(), file), location.line, location.col)
  return fingerprint ? { nodeId: edit.nodeId, fingerprint } : null
}

function describeFingerprint(fingerprint: string): string {
  const label = sourceFingerprintLabel(fingerprint)
  return label === LITERAL_FINGERPRINT_LABEL ? 'text' : `<${label}>`
}

function movedMessage(rel: string, line: number, expected: string, actual: string | undefined): string {
  const now =
    actual === undefined
      ? 'nothing Studio can edit is written there now'
      : `${describeFingerprint(actual) === describeFingerprint(expected) ? 'a different ' : ''}${describeFingerprint(actual)} is there now`
  return (
    `${rel} changed since the board read it: the ${describeFingerprint(expected)} this change was aimed at is no ` +
    `longer at line ${line} (${now}). Nothing was written.`
  )
}
