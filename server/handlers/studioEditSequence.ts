/**
 * studioEditSequence — a structural gesture that is several WRITES, each one
 * aimed at the file the previous one left: applied in order, all or nothing
 * (P3-D, ERR-7 / ERR-16 / WB-22).
 *
 * ## Why a batch cannot do this
 *
 * `applyStudioEditBatch` applies a batch bottom-to-top, and that ordering is
 * honest only when the edits are INDEPENDENT: no edit's write may move a line
 * another edit still names. A multi-selection drag is not like that. Dragging
 * cards A and C to after E is "A after E, then C after A": the second write
 * names A, which the first one just moved, and E, whose line the first one
 * shifted. A non-adjacent group is "bring the members together, then wrap
 * them". Neither has an order the batch can find by sorting.
 *
 * ## What a sequence does instead
 *
 * Each edit runs as its own one-edit batch, and before it runs every node id
 * it names is RE-ADDRESSED to where that element is after the edits before it.
 * The re-addressing is exact, not a guess:
 *
 *   - the element a step MOVED is where the codemod reported putting it
 *     (`relocatedNodeIds`) — the same answer the board selects;
 *   - every OTHER element keeps its place in the file's document order, which
 *     is what a move, a delete, a copy or a wrapper leaves untouched for the
 *     elements it does not act on. So the k-th JSX element before the step,
 *     not counting the ones the step acted on, is the k-th one after it
 *     (`followThroughStep`). Line diffs would be ambiguous exactly where real
 *     pages repeat themselves — six identical `<Card/>` lines — and order is
 *     not.
 *
 * The caller's identities (`expect`, P1-A) are checked ONCE, before the first
 * step, against the files it read — P1-D re-finds an element an outside
 * change moved, exactly as a batch does. An id the order follower loses (its
 * element was acted on, or the two orders disagree) is never guessed at: a
 * later step that names it refuses the whole sequence.
 *
 * ## All or nothing
 *
 * The first step that does not write ends the sequence, and every file any
 * step touched is put back to the bytes it had before the first one. A drag
 * that moved two of three cards is a canvas the file does not describe; the
 * store's rollback takes the gesture back on the board, and this takes it back
 * on disk. The answer reports that one refusal under the id the caller sent.
 *
 * Only the kinds whose effect on the other elements' order is known
 * ({@link SEQUENCE_KINDS}) may be sequenced; anything else refuses the whole
 * sequence before a byte is written.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Node, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile, resolveJsxChildRange } from '@core/ast-codemods'
import { ELEMENT_MOVED_REASON, withSourceLocation, type SourceFingerprintExpectations } from '@core/page-tree'
import { refusalFor } from './studioEditRefusals'
import { editNamedNodeIds, resolveEditIdentities } from './studioEditIdentity'
import { studioEditFile, studioEditLocation } from './studioEditRouting'
import type { StudioEdit, StudioEditBatchResult, StudioEditRefusal } from './studioEditSchemas'
import { applyStudioEditBatch } from './studioWriteback'
import { rememberSourceTexts } from './studio/sourceTextHistory'
import { withProjectWriteLock } from './studio/projectWriteLock'

/** The edit kinds a sequence may hold — each one's effect on every OTHER element is known. */
const SEQUENCE_KINDS = new Set<StudioEdit['kind']>([
  'move',
  'reparent',
  'transplant',
  'delete',
  'duplicate',
  'insert',
  'reinsert-source',
  'wrap',
  'group',
  'ungroup',
])

/** One JSX element as the order-follower sees it: where its tag name starts. */
interface ElementMark {
  /** Offset of the tag NAME — the position a node id's `line:col` decodes to. */
  start: number
  /** The whole element's extent, for "is this inside that". */
  end: number
}

/** Every JSX element of a file, in document order. */
function elementMarks(sourceFile: SourceFile): ElementMark[] {
  const marks: ElementMark[] = []
  sourceFile.forEachDescendant((node) => {
    if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return
    const whole = Node.isJsxOpeningElement(node) ? node.getParentOrThrow() : node
    if (!Node.isJsxElement(whole) && !Node.isJsxSelfClosingElement(whole)) return
    marks.push({ start: node.getTagNameNode().getStart(), end: whole.getEnd() })
  })
  return marks
}

function offsetOf(sourceFile: SourceFile, line: number, col: number): number | null {
  const starts = sourceFile.compilerNode.getLineStarts()
  if (line < 1 || line > starts.length) return null
  return starts[line - 1]! + col - 1
}

/** The `[start, end)` a structural codemod acts on at `line:col` — see `resolveJsxChildRange`'s `'conditional'` unit. */
function unitRange(sourceFile: SourceFile, line: number, col: number): { start: number; end: number } | null {
  const resolved = resolveJsxChildRange(sourceFile, line, col, 'conditional')
  if (!resolved.ok) return null
  const branch = resolved.range.ternaryBranch
  return branch ?? { start: resolved.range.element.getStart(), end: resolved.range.element.getEnd() }
}

/** A position a step acted on: every element whose tag starts inside `[start, end)`, or exactly the one at `start` (`only`). */
interface ActedOn {
  start: number
  end: number
  only?: true
}

/** Which elements of the file BEFORE the step the step acted on — they are not followed by order. */
function actedOnBefore(edit: StudioEdit, file: string, sourceFile: SourceFile, dir: string): ActedOn[] {
  const location = studioEditLocation(dir, edit.nodeId)
  if (!location || studioEditFile(dir, edit.nodeId) !== file) return []
  const removesTarget =
    edit.kind === 'move' ||
    edit.kind === 'reparent' ||
    edit.kind === 'delete' ||
    (edit.kind === 'transplant' && edit.copy !== true)
  if (removesTarget) {
    const range = unitRange(sourceFile, location.line, location.col)
    return range ? [range] : []
  }
  if (edit.kind === 'ungroup') {
    const at = offsetOf(sourceFile, location.line, location.col)
    return at === null ? [] : [{ start: at, end: at + 1, only: true }]
  }
  return []
}

/** Which elements of the file AFTER the step the step made or put there. */
function actedOnAfter(edit: StudioEdit, sourceFile: SourceFile, placed: readonly { line: number; col: number }[]): ActedOn[] {
  const acted: ActedOn[] = []
  for (const at of placed) {
    if (edit.kind === 'wrap' || edit.kind === 'group') {
      // The wrapper is new; what it holds is the run that was already there.
      const offset = offsetOf(sourceFile, at.line, at.col)
      if (offset !== null) acted.push({ start: offset, end: offset + 1, only: true })
      continue
    }
    if (edit.kind === 'ungroup') continue // the released children kept their order
    const range = unitRange(sourceFile, at.line, at.col)
    if (range) acted.push(range)
  }
  return acted
}

function isActedOn(mark: ElementMark, acted: readonly ActedOn[]): boolean {
  return acted.some((range) => (range.only ? mark.start === range.start : mark.start >= range.start && mark.start < range.end))
}

/**
 * Where each of `offsets` (tag-name offsets in `before`) is in `after`, by
 * document order among the elements the step did not act on — `null` for one
 * that cannot be followed (it was acted on, or the two orders disagree).
 */
function followThroughStep(
  before: SourceFile,
  after: SourceFile,
  actedBefore: readonly ActedOn[],
  actedAfter: readonly ActedOn[],
  offsets: readonly number[],
): Map<number, number | null> {
  const kept = elementMarks(before).filter((mark) => !isActedOn(mark, actedBefore))
  const now = elementMarks(after).filter((mark) => !isActedOn(mark, actedAfter))
  const answer = new Map<number, number | null>()
  const aligned = kept.length === now.length
  for (const offset of offsets) {
    const index = kept.findIndex((mark) => mark.start === offset)
    const target = aligned && index >= 0 ? now[index]! : null
    answer.set(offset, target ? target.start : null)
  }
  return answer
}

/** The node id at `offset` of `sourceFile`, keeping `nodeId`'s call-site prefix. */
function idAtOffset(nodeId: string, sourceFile: SourceFile, offset: number): string | null {
  const { line, column } = sourceFile.getLineAndColumnAtPos(offset)
  return withSourceLocation(nodeId, line, column)
}

function readTexts(files: Iterable<string>): Map<string, Buffer | null> {
  const texts = new Map<string, Buffer | null>()
  for (const file of files) texts.set(file, existsSync(file) ? readFileSync(file) : null)
  return texts
}

/** Every absolute file an edit can write: the files its node ids decode to (a transplant's destination included). */
function filesOf(dir: string, edit: StudioEdit): string[] {
  return editNamedNodeIds(edit).map((nodeId) => studioEditFile(dir, nodeId)).filter((file): file is string => file !== null)
}

function readdress(edit: StudioEdit, rename: (nodeId: string) => string): StudioEdit {
  if (edit.kind === 'css') return edit
  const next = { ...edit, nodeId: rename(edit.nodeId) }
  if ('anchorNodeId' in next && next.anchorNodeId) next.anchorNodeId = rename(next.anchorNodeId)
  if ('parentNodeId' in next && next.parentNodeId) next.parentNodeId = rename(next.parentNodeId)
  if ('siblingNodeIds' in next) next.siblingNodeIds = next.siblingNodeIds.map(rename)
  return next
}

function refused(edits: readonly StudioEdit[], refusals: StudioEditRefusal[], touchedFiles: Iterable<string>): StudioEditBatchResult {
  return {
    written: 0,
    skipped: edits.length,
    shifted: false,
    sharedComponents: false,
    refusals,
    swapDetails: [],
    createdStylesheets: [],
    promoteDetails: [],
    addSlotPropDetails: [],
    touchedFiles: [...touchedFiles],
    createdNodeIds: [],
    relocatedNodeIds: [],
    removed: [],
    prunedImports: [],
    fingerprints: [],
    retargeted: [],
  }
}

/**
 * Apply `edits` in order, each against the files the previous ones left — see
 * this module's doc. `expect` is the caller's identity for the ids it sent,
 * checked against the files as they are before the first step (P1-A; P1-D
 * re-finds an element an outside change moved, exactly as a batch does).
 */
export function applyStudioEditSequence(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations = {},
): StudioEditBatchResult {
  const unsupported = edits.find((edit) => !SEQUENCE_KINDS.has(edit.kind))
  if (unsupported) {
    return refused(edits, [
      refusalFor(unsupported, 'not-sequenced', 'Studio cannot write this change as one step of a larger gesture, so nothing was written.'),
    ], [])
  }

  // P1-A/P1-D, once, against the files as the caller read them.
  const identity = resolveEditIdentities(dir, edits, expect)
  if (identity.moved.length > 0) {
    return refused(edits, identity.moved.map((entry) => entry.refusal), edits.flatMap((edit) => filesOf(dir, edit)))
  }

  // Every id any edit names is FOLLOWED from here on, keyed by the id the
  // caller sent: `current` is where that element is now.
  const current = new Map<string, string>()
  for (const [index, edit] of edits.entries()) {
    const runnable = identity.runnable[index]!
    const sent = editNamedNodeIds(edit)
    const now = editNamedNodeIds(runnable)
    sent.forEach((nodeId, i) => current.set(nodeId, now[i] ?? nodeId))
  }

  const originals = readTexts(new Set(edits.flatMap((edit) => filesOf(dir, edit))))
  const lineCountBefore = new Map([...originals].map(([file, bytes]) => [file, bytes ? bytes.toString('utf8').split('\n').length : -1]))
  const touched = new Set<string>()
  const created: { key: string; nodeId: string }[] = []
  const relocated = new Map<string, string>()
  const removed: StudioEditBatchResult['removed'] = []
  const prunedImports: StudioEditBatchResult['prunedImports'] = []
  let sharedComponents = false

  const restore = (): void => {
    for (const [file, bytes] of originals) {
      if (bytes === null) continue
      writeFileSync(file, bytes)
    }
    rememberSourceTexts(originals.keys())
  }

  // An id the sequence could not follow through a step. A later step that
  // names one refuses (and restores) rather than writing at a stale line.
  const lost = new Set<string>()

  for (const [index, edit] of edits.entries()) {
    const sentIds = editNamedNodeIds(edit)
    const stale = sentIds.find((nodeId) => lost.has(nodeId))
    if (stale !== undefined) {
      restore()
      return refused(edits, [
        refusalFor(edit, ELEMENT_MOVED_REASON, 'An element this change names could not be followed through the steps before it, so none of it was written.'),
      ], [...touched, ...originals.keys()])
    }
    const step = readdress(edit, (nodeId) => current.get(nodeId) ?? nodeId)
    const stepFiles = [...new Set(filesOf(dir, step))]
    for (const file of stepFiles) if (!originals.has(file)) originals.set(file, existsSync(file) ? readFileSync(file) : null)
    const project = createProject()
    const before = new Map(stepFiles.filter((file) => existsSync(file)).map((file) => [file, loadSourceFile(project, file)]))

    // No `expect` here: the caller's identities were checked once, above,
    // against the files it read, and every id since then is where the order
    // follower put it — an identity read off the file this step is about to
    // write would only ever agree with itself.
    const result = applyStudioEditBatch(dir, [step], {})
    for (const file of result.touchedFiles) touched.add(file)
    sharedComponents ||= result.sharedComponents
    if (result.written === 0 || result.refusals.length > 0) {
      restore()
      const refusals = result.refusals.map((refusal) => ({ ...refusal, nodeId: edit.nodeId }))
      return refused(edits, refusals.length > 0 ? refusals : [
        refusalFor(edit, 'not-written', 'Studio could not write one step of this change, so none of it was written.'),
      ], [...touched, ...originals.keys()])
    }
    for (const entry of result.removed) removed.push({ ...entry, nodeId: edit.nodeId })
    prunedImports.push(...result.prunedImports)

    // Follow every id the sequence still cares about through this step.
    const placed = [...result.relocatedNodeIds, ...result.createdNodeIds]
    const afterProject = createProject()
    for (const [file, beforeFile] of before) {
      if (!existsSync(file)) continue
      const afterFile = loadSourceFile(afterProject, file)
      const placedHere = placed
        .map((nodeId) => (studioEditFile(dir, nodeId) === file ? studioEditLocation(dir, nodeId) : null))
        .filter((location): location is NonNullable<typeof location> => location !== null)
      const followed: { key: string; nodeId: string; offset: number }[] = []
      const follow = (key: string, nodeId: string): void => {
        if (studioEditFile(dir, nodeId) !== file) return
        const location = studioEditLocation(dir, nodeId)
        const offset = location ? offsetOf(beforeFile, location.line, location.col) : null
        if (offset !== null) followed.push({ key, nodeId, offset })
      }
      for (const [sentId, nodeId] of current) follow(`id:${sentId}`, nodeId)
      for (const entry of created) follow(`created:${entry.key}`, entry.nodeId)
      for (const [sentId, nodeId] of relocated) follow(`relocated:${sentId}`, nodeId)
      const moved = followThroughStep(
        beforeFile,
        afterFile,
        actedOnBefore(step, file, beforeFile, dir),
        actedOnAfter(step, afterFile, placedHere),
        followed.map((entry) => entry.offset),
      )
      for (const entry of followed) {
        const target = moved.get(entry.offset)
        const nextId = target === null || target === undefined ? null : idAtOffset(entry.nodeId, afterFile, target)
        const [kind, key] = [entry.key.slice(0, entry.key.indexOf(':')), entry.key.slice(entry.key.indexOf(':') + 1)]
        if (kind === 'id') {
          if (nextId) current.set(key, nextId)
          else {
            current.delete(key)
            lost.add(key)
          }
        } else if (kind === 'created') {
          const record = created.find((candidate) => candidate.key === key)
          if (record && nextId) record.nodeId = nextId
        } else if (nextId) {
          relocated.set(key, nextId)
        }
      }
    }

    // What THIS step did to its own target: it went where the codemod says.
    const [targetSentId] = sentIds
    if (result.relocatedNodeIds.length === 1 && targetSentId && edit.kind !== 'ungroup') {
      current.set(targetSentId, result.relocatedNodeIds[0]!)
      relocated.set(targetSentId, result.relocatedNodeIds[0]!)
      lost.delete(targetSentId)
    }
    result.createdNodeIds.forEach((nodeId, i) => created.push({ key: `${index}:${i}`, nodeId }))
  }

  let shifted = false
  const touchedFiles = new Set([...touched, ...originals.keys()])
  for (const file of touchedFiles) {
    const after = existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : -1
    if (after !== lineCountBefore.get(file)) shifted = true
  }
  return {
    written: edits.length,
    skipped: 0,
    shifted,
    sharedComponents,
    refusals: [],
    swapDetails: [],
    createdStylesheets: [],
    promoteDetails: [],
    addSlotPropDetails: [],
    touchedFiles: [...touchedFiles],
    createdNodeIds: created.map((entry) => entry.nodeId),
    relocatedNodeIds: [...relocated.values()],
    removed,
    prunedImports,
    fingerprints: [],
    retargeted: identity.retargeted,
  }
}

/**
 * {@link applyStudioEditSequence} under the project's write lock — the entry
 * the `/save` route uses when the client asks for `sequence`. Same reason the
 * batch has its locked twin: a git verb must never see half a sequence.
 */
export function applyStudioEditSequenceLocked(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations = {},
): Promise<StudioEditBatchResult> {
  return withProjectWriteLock(dir, () => applyStudioEditSequence(dir, edits, expect))
}
