/**
 * unsavedEditRebase — the user's unsaved edits survive a re-read of the file
 * they were made in (ERR-9, `docs/audits/2026-09-23-studio-audit/
 * 02-errors-client.md`).
 *
 * A re-read replaces a page wholesale: `patchPages` after the user's own save
 * or structural commit, after an agent's write, after a file changed outside
 * Studio (P1-D); `loadSite` when the scope cannot be proven narrow. Whatever
 * the user had typed since the last save used to go with it — silently on the
 * full path, and on the narrow one with a toast that blamed "an agent" even
 * when the write was the user's own ⌘D. Typing in the inspector during the
 * ~0.3–2 s a structural write takes to come back was enough.
 *
 * Now every such re-read REBASES instead:
 *
 *  1. **What is unsaved.** For each replaced page, every node value that
 *     differs from the save-diff baseline the re-read replaced
 *     (`loadedValuesBaseline.ts`'s `baselineBeforeRead`) — the same keys, the
 *     same comparison `saveSite` makes, so "unsaved" means exactly what the next
 *     save would have sent: props, call-site props, inline styles (a removal
 *     included) and the class list.
 *  2. **Where it goes.** The page as it was BEFORE those edits (the old tree
 *     with each edited value put back) is aligned with the fresh tree by
 *     content (`reparseNodeFollow.ts`'s `alignPageTrees` — the same answer the
 *     selection follows). An element alignment cannot place is re-found by its
 *     source identity (P1-A's table), and only a single match counts.
 *  3. **Three-way, per value.** Fresh already equals the local value: nothing
 *     to do (a save that was in flight landed it). Otherwise the local value is
 *     written onto the fresh node — the user typed it after the tree they were
 *     looking at, which is also what the P1-D flush-first path does when it
 *     posts pending edits before re-reading.
 *  4. **Per node, all or nothing.** A node's edits are carried whole or not at
 *     all (a half-applied patch is a canvas that disagrees with its file). One
 *     is NOT carried when the element is gone, when a value it touches is now
 *     set in code (`isPropWritableToSource` on the FRESH node — writing a
 *     literal there would bake over a binding), or when a value the parser
 *     traced to a literal elsewhere now comes from a different file, or was
 *     changed there too: a local-wins write to a literal is a write into
 *     someone else's copy (a locale switch re-reads every text from another
 *     dictionary).
 *
 * The rebased page keeps its save marks, so autosave writes exactly the
 * carried edits against the fresh baseline. Nothing is said when every edit
 * was carried. One warning names what was not, and why — never who.
 *
 * Cost: O(nodes) of the replaced pages to find what is unsaved (the same walk
 * the save makes), plus one alignment per page that actually holds an unsaved
 * edit. Pure: reads frozen trees, returns new page objects for the pages it
 * changed and the fresh ones untouched otherwise.
 */
import { registry } from '@core/module-engine'
import {
  decodeSourceNodeId,
  getNodeDisplayName,
  isPropWritableToSource,
  STYLE_VALUE_PREFIX,
  type Page,
  type PageNode,
} from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { literalInlineStyles, type BaselineBeforeRead } from '@site/studio/loadedValuesBaseline'
import { captureIdentities } from '@site/studio/sourceIdentity'
import { alignPageTrees } from './reparseNodeFollow'

type Scalar = string | number | boolean

const CALL_SITE_PREFIX = 'callSiteProps:'

/** One value changed since the last save, under the baseline's key. `local: undefined` is a removed inline style. */
interface PendingValue {
  key: string
  base: Scalar | undefined
  local: Scalar | undefined
}

/** Everything unsaved on one node. */
interface PendingNodeEdit {
  node: PageNode
  values: PendingValue[]
  classIds: { base: readonly string[]; local: readonly string[] } | null
}

/** Why an unsaved edit could not be carried onto the re-read page. */
export type LostEditReason = 'element-gone' | 'now-code' | 'source-changed'

export interface LostUnsavedEdit {
  nodeId: string
  label: string
  reason: LostEditReason
}

export interface UnsavedEditRebase {
  /** The incoming pages, in order — a page holding a carried edit replaced by its rebased copy. */
  pages: Page[]
  /** Pages that now hold carried edits: still unsaved, so still marked for the next save. */
  rebasedPageIds: ReadonlySet<string>
  lost: LostUnsavedEdit[]
}

function asScalar(value: unknown): Scalar | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined
}

function callSiteProps(node: PageNode): Record<string, unknown> {
  return (node.props as { callSiteProps?: Record<string, unknown> } | undefined)?.callSiteProps ?? {}
}

/** The value `node` holds under a baseline key — see `snapshotNodeValues`. */
function readValue(node: PageNode, key: string): Scalar | undefined {
  if (key.startsWith(STYLE_VALUE_PREFIX)) {
    const value = asScalar(node.inlineStyles?.[key.slice(STYLE_VALUE_PREFIX.length)])
    return typeof value === 'boolean' ? undefined : value
  }
  if (key.startsWith(CALL_SITE_PREFIX)) return asScalar(callSiteProps(node)[key.slice(CALL_SITE_PREFIX.length)])
  return asScalar(node.props?.[key])
}

/** `node` with `key` set to `value` (or removed, for `undefined`). Never mutates `node`. */
function writeValue(node: PageNode, key: string, value: Scalar | undefined): PageNode {
  if (key.startsWith(STYLE_VALUE_PREFIX)) {
    const property = key.slice(STYLE_VALUE_PREFIX.length)
    const inlineStyles = { ...(node.inlineStyles ?? {}) }
    if (value === undefined) delete inlineStyles[property]
    else inlineStyles[property] = value as string | number
    return { ...node, inlineStyles }
  }
  if (key.startsWith(CALL_SITE_PREFIX)) {
    const name = key.slice(CALL_SITE_PREFIX.length)
    const next = { ...callSiteProps(node) }
    if (value === undefined) delete next[name]
    else next[name] = value
    return { ...node, props: { ...node.props, callSiteProps: next } }
  }
  const props = { ...node.props }
  if (value === undefined) delete props[key]
  else props[key] = value
  return { ...node, props }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** Every value on `node` that differs from `baseline` — what the next save would send for it. */
function pendingEditOf(node: PageNode, baseline: BaselineBeforeRead): PendingNodeEdit | null {
  const base = baseline.values(node.id)
  // Never observed by the baseline: an optimistic preview or a clone waiting
  // for its structural write — the re-read replaces it by design.
  if (!base) return null
  const keys = new Set<string>()
  for (const [prop, value] of Object.entries(node.props ?? {})) if (asScalar(value) !== undefined) keys.add(prop)
  if (node.moduleId === 'studio.instance') {
    for (const name of Object.keys(callSiteProps(node))) keys.add(CALL_SITE_PREFIX + name)
  }
  for (const property of Object.keys(literalInlineStyles(node.inlineStyles))) keys.add(STYLE_VALUE_PREFIX + property)
  // A removed inline style is only visible as a baseline key the node lacks.
  for (const key of Object.keys(base)) if (key.startsWith(STYLE_VALUE_PREFIX)) keys.add(key)

  const values: PendingValue[] = []
  for (const key of keys) {
    const local = readValue(node, key)
    if (!Object.is(local, base[key])) values.push({ key, base: base[key], local })
  }
  const baseClassIds = baseline.classIds(node.id)
  const classIds = baseClassIds && !sameIds(baseClassIds, node.classIds) ? { base: baseClassIds, local: node.classIds } : null
  return values.length > 0 || classIds ? { node, values, classIds } : null
}

/** Where a value the parser traced to a literal is written — `null` for a value that is this element's own. */
function originOf(node: PageNode, key: string): { rel: string } | null {
  const traced = node.resolvedProps?.[key]?.origin
  if (traced) return traced
  const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
  return key === textProp && node.textOrigin ? node.textOrigin : null
}

/** The page as it read before the user's edits: each edited value put back to its baseline. */
function pageBeforeEdits(page: Page, edits: readonly PendingNodeEdit[]): Page {
  const nodes = { ...page.nodes }
  for (const { node, values, classIds } of edits) {
    let reverted = node
    for (const { key, base } of values) reverted = writeValue(reverted, key, base)
    if (classIds) reverted = { ...reverted, classIds: [...classIds.base] }
    nodes[node.id] = reverted
  }
  return { ...page, nodes }
}

/**
 * The fresh id of the element `oldId` named, found by its source identity —
 * the fallback for an element alignment could not place (it moved to another
 * parent). Only a single match in the same file counts.
 */
function refindByIdentity(oldNode: PageNode, fresh: Page): string | null {
  const fingerprint = captureIdentities([oldNode.id]).get(oldNode.id)?.fingerprint ?? oldNode.sourceFingerprint
  const rel = decodeSourceNodeId(oldNode.id)?.rel
  if (!fingerprint || !rel) return null
  const matches = Object.values(fresh.nodes).filter(
    (node) => node.sourceFingerprint === fingerprint && decodeSourceNodeId(node.id)?.rel === rel,
  )
  return matches.length === 1 ? matches[0]!.id : null
}

/** `edit` written onto `target`, or why it cannot be — see this module's doc, steps 3 and 4. */
function carryEdit(edit: PendingNodeEdit, target: PageNode): PageNode | LostEditReason {
  let next = target
  for (const { key, base, local } of edit.values) {
    const fresh = readValue(target, key)
    if (Object.is(fresh, local)) continue
    if (!isPropWritableToSource(target, key)) return 'now-code'
    const was = originOf(edit.node, key)
    if (was) {
      const now = originOf(target, key)
      if (!now || now.rel !== was.rel || !Object.is(fresh, base)) return 'source-changed'
    }
    next = writeValue(next, key, local)
  }
  if (edit.classIds && !sameIds(target.classIds, edit.classIds.local)) next = { ...next, classIds: [...edit.classIds.local] }
  return next
}

/**
 * Rebase the unsaved edits held by `current` onto the `fresh` pages a re-read
 * produced. `baseline` is what the save diff said before that re-read
 * (`baselineBeforeRead(fresh)`); without one there is no honest record of what
 * is unsaved, and the fresh pages are returned as they are.
 */
export function rebaseUnsavedEdits(
  current: readonly Page[],
  fresh: readonly Page[],
  baseline: BaselineBeforeRead | undefined,
): UnsavedEditRebase {
  const rebasedPageIds = new Set<string>()
  const lost: LostUnsavedEdit[] = []
  if (!baseline) return { pages: [...fresh], rebasedPageIds, lost }
  const currentById = new Map(current.map((page) => [page.id, page]))

  const pages = fresh.map((freshPage) => {
    const page = currentById.get(freshPage.id)
    if (!page || page === freshPage) return freshPage
    const edits: PendingNodeEdit[] = []
    for (const node of Object.values(page.nodes)) {
      const edit = pendingEditOf(node, baseline)
      if (edit) edits.push(edit)
    }
    if (edits.length === 0) return freshPage

    const alignment = alignPageTrees(pageBeforeEdits(page, edits), freshPage)
    const carried: Record<string, PageNode> = {}
    for (const edit of edits) {
      const loss = (reason: LostEditReason) =>
        lost.push({ nodeId: edit.node.id, label: getNodeDisplayName(edit.node, registry.get(edit.node.moduleId), undefined), reason })
      const freshId = alignment.get(edit.node.id) ?? refindByIdentity(edit.node, freshPage)
      const target = freshId === null ? undefined : (carried[freshId] ?? freshPage.nodes[freshId])
      if (!target) {
        loss('element-gone')
        continue
      }
      const next = carryEdit(edit, target)
      if (typeof next === 'string') loss(next)
      else if (next !== target) carried[target.id] = next
    }
    if (Object.keys(carried).length === 0) return freshPage
    rebasedPageIds.add(freshPage.id)
    return { ...freshPage, nodes: { ...freshPage.nodes, ...carried } }
  })
  return { pages, rebasedPageIds, lost }
}

const LOSS_SENTENCE: Record<LostEditReason, (label: string) => string> = {
  'element-gone': (label) => `“${label}” is no longer in the file, so the change you made to it was not kept.`,
  'now-code': (label) => `“${label}” now takes that value from code, so the value you typed was not written over it.`,
  'source-changed': (label) =>
    `The text of “${label}” was changed where it is defined while you were editing it, so your change was not written over it.`,
}

/**
 * The one message for edits a re-read could not carry — a warning with the
 * actual reason, never an attribution: the board cannot know who wrote the
 * file, and "an agent" was wrong whenever it was the user's own write.
 */
export function reportLostUnsavedEdits(lost: readonly LostUnsavedEdit[]): void {
  if (lost.length === 0) return
  const [first] = lost
  const more = lost.length > 1 ? ` ${lost.length - 1} more change${lost.length === 2 ? '' : 's'} could not be kept either.` : ''
  pushToast({
    kind: 'warning',
    title: 'Not saved — the file changed',
    body: `${LOSS_SENTENCE[first!.reason](first!.label)}${more} The board shows the file as it is now.`,
    location: 'site-editor',
  })
}
