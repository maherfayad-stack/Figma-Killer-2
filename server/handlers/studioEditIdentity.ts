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
 *   - {@link resolveEditIdentities}: BEFORE any byte of the batch is written,
 *     which edits name an id whose position now holds something else? Each
 *     such id is re-found in the changed file (P1-D, `studioEditRelocate.ts`)
 *     and the edit re-addressed to where it is now — or, when there is not
 *     exactly one place it can be, the edit refuses `element-moved` and never
 *     reaches a codemod. Checked against the files as they are before the
 *     batch, because that is the state the expectations describe — a batch
 *     applies bottom-to-top, and a prop edit and a style edit on ONE element
 *     would otherwise see each other's change as a move.
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
 * P1-D re-locates on top of this: the same `readSourceFingerprintAt`
 * comparison, run over the positions a line diff proposes. A re-found edit is
 * reported back as `retargeted` (original id → id it was written at), and the
 * batch counts as `shifted`: every id the caller decoded for that file is
 * stale, which is exactly what `shifted` tells it.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, SourceFile } from 'ts-morph'
import { loadSourceFile, readSourceFingerprintAt } from '@core/ast-codemods'
import { LITERAL_FINGERPRINT_LABEL } from '@core/page-parser'
import {
  ELEMENT_MOVED_REASON,
  sourceFingerprintLabel,
  withSourceLocation,
  type SourceFingerprintExpectations,
} from '@core/page-tree'
import { refusalFor } from './studioEditRefusals'
import { relocateSourcePosition } from './studioEditRelocate'
import { studioEditLocation, type SourceTargetScope } from './studioEditRouting'
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

/** An edit whose target was re-found somewhere else in its changed file: the id it named, and the id it was written at. */
export interface RetargetedEdit {
  nodeId: string
  to: string
}

export interface ResolvedEditIdentities {
  /** The edits that may run, in input order — re-found ones re-addressed to where their elements are now. */
  runnable: StudioEdit[]
  /** The edits that must not run, each with its `element-moved` refusal. Carries the edit as the caller sent it. */
  moved: { edit: StudioEdit; refusal: StudioEditRefusal }[]
  /** One entry per re-addressed node id — see {@link RetargetedEdit}. */
  retargeted: RetargetedEdit[]
}

/** `edit` with every node id it names passed through `rename`. */
function readdressEdit(edit: StudioEdit, rename: (nodeId: string) => string): StudioEdit {
  if (edit.kind === 'css') return edit
  const next = { ...edit, nodeId: rename(edit.nodeId) }
  if ('anchorNodeId' in next && next.anchorNodeId) next.anchorNodeId = rename(next.anchorNodeId)
  if ('parentNodeId' in next && next.parentNodeId) next.parentNodeId = rename(next.parentNodeId)
  if ('siblingNodeIds' in next) next.siblingNodeIds = next.siblingNodeIds.map(rename)
  return next
}

/**
 * Decide, before the batch writes a byte, which edits still name the element
 * the caller read (run them as sent), which name an element that has moved
 * within its file (re-address them — P1-D), and which name one that cannot be
 * found exactly once (refuse `element-moved`). Reads each named file once,
 * into the batch's own project (WB-25), so the codemods that follow do not
 * parse the same file again.
 */
export function resolveEditIdentities(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations,
  project: Project,
  scope?: SourceTargetScope,
): ResolvedEditIdentities {
  if (Object.keys(expect).length === 0) return { runnable: [...edits], moved: [], retargeted: [] }
  const files = new Map<string, SourceFile | null>()
  const readFile = (file: string): SourceFile | null => {
    if (!files.has(file)) files.set(file, existsSync(file) ? loadSourceFile(project, file) : null)
    return files.get(file)!
  }
  // One answer per id for the whole batch: two edits naming one element must
  // agree on where it is.
  const found = new Map<string, string | { refusal: string }>()
  const locate = (nodeId: string, expected: string): string | { refusal: string } => {
    const known = found.get(nodeId)
    if (known !== undefined) return known
    const location = studioEditLocation(dir, nodeId, scope)
    let answer: string | { refusal: string }
    if (!location) {
      answer = nodeId // synthetic, or refused by the path guard — the codemod path answers that
    } else {
      const absFile = join(dir, location.rel)
      const sourceFile = readFile(absFile)
      const actual = sourceFile ? readSourceFingerprintAt(sourceFile, location.line, location.col) : undefined
      const relocated =
        actual === expected || !sourceFile
          ? null
          : relocateSourcePosition(absFile, sourceFile, location.line, location.col, expected)
      const readdressed = relocated ? withSourceLocation(nodeId, relocated.line, relocated.col) : null
      answer =
        actual === expected
          ? nodeId
          : readdressed ?? { refusal: movedMessage(location.rel, location.line, expected, actual) }
    }
    found.set(nodeId, answer)
    return answer
  }

  const runnable: StudioEdit[] = []
  const moved: ResolvedEditIdentities['moved'] = []
  const renamed = new Map<string, string>()
  for (const edit of edits) {
    let refusal: string | null = null
    const renames = new Map<string, string>()
    for (const nodeId of editNamedNodeIds(edit)) {
      const expected = expect[nodeId]
      if (expected === undefined) continue
      const answer = locate(nodeId, expected)
      if (typeof answer !== 'string') {
        refusal = answer.refusal
        break
      }
      if (answer !== nodeId) renames.set(nodeId, answer)
    }
    if (refusal !== null) {
      moved.push({ edit, refusal: refusalFor(edit, ELEMENT_MOVED_REASON, refusal) })
      continue
    }
    for (const [from, to] of renames) renamed.set(from, to)
    runnable.push(renames.size > 0 ? readdressEdit(edit, (nodeId) => renames.get(nodeId) ?? nodeId) : edit)
  }
  return { runnable, moved, retargeted: [...renamed].map(([nodeId, to]) => ({ nodeId, to })) }
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
 *
 * Read through the batch's own project (WB-25): the codemod that just wrote
 * the file left it parsed there, so this costs a read and a compare rather
 * than a second parse.
 */
export function fingerprintAfterWrite(
  dir: string,
  edit: StudioEdit,
  project: Project,
  scope?: SourceTargetScope,
): { nodeId: string; fingerprint: string } | null {
  if (!IDENTITY_CHANGING_VALUE_KINDS.has(edit.kind)) return null
  const location = studioEditLocation(dir, edit.nodeId, scope)
  if (!location) return null
  const file = join(dir, location.rel)
  if (!existsSync(file)) return null
  const fingerprint = readSourceFingerprintAt(loadSourceFile(project, file), location.line, location.col)
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
