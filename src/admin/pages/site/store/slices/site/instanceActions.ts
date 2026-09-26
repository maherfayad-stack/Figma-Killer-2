/**
 * instanceActions — P5-C (DET-5): the ONE Detach action.
 *
 * The Component section's button, both context menus (the Layers panel's and
 * the canvas's, which render the same `LayerNodeContextMenu`), ⌘⌥B /
 * Ctrl+Alt+B and the refusal remedy ("Detach this instance") all call
 * `detachInstances(nodeIds)`. So there is one place for each of the four
 * things a detach owes the user:
 *
 *   1. **The confirm — only when something is lost.** A plain detach is
 *      instant, as in Figma. The codemod itself says what a detach loses
 *      (`detachDetails`): other rendered states the component can be in, a
 *      context hook written into the page's component (DET-3), or a call
 *      site one `.map` template renders for EVERY row. One call site is
 *      posted with `dryRun: 'if-lossy'` — written in one round trip when
 *      nothing is lost, held back and reported otherwise; a multi-selection
 *      is previewed (`dryRun: 'always'`) first, so one confirm covers the
 *      whole gesture. Nothing reaches the disk before the user agrees.
 *   2. **The undo entry.** The write goes through `commitStructural`
 *      (`commitStudioDetach`) with the undo journal's `restore-journal`
 *      template: one ⌘Z puts every file back byte for byte, however many
 *      instances the gesture detached (a multi-selection is ONE server
 *      `sequence`, journaled once).
 *   3. **The refusal.** A refused detach is shown through
 *      `presentStructuralRefusal` with `explainDetachConstraint` — the dialog
 *      with "Duplicate as a new file" for the reasons a copy would fix, a
 *      toast for the rest.
 *   4. **The selection.** The resync selects what replaced each call site
 *      (`select: 'created'`).
 *
 * Which call site a node names:
 *   - a plain instance: its own id;
 *   - a `.map` row's instance (`…#2`): the row TEMPLATE (`loopTemplateNodeId`)
 *     — the one piece of JSX every row shares, so the confirm says "every row
 *     (N)" before it is written;
 *   - an instance INSIDE another component's markup (a composite id): OD-7 —
 *     the enclosing instance is detached first, then this one, and one ⌘Z
 *     takes back both (`applyToThisInstanceOnly`). Writing the detach into
 *     the shared component's file would change every instance of it.
 *
 * Posts edits, never mutates a tree: `no-vc-mode-branches-in-mutations` does
 * not apply (the same posture as `imageDropActions.ts`).
 */
import {
  decodeSourceNodeId,
  explainDetachConstraint,
  hasWritableSourceLocation,
  isInlinedNodeId,
  loopTemplateNodeId,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import { captureIdentities } from '@site/studio/sourceIdentity'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { postEdits, type StudioSaveResponse } from '@site/studio/studioSaveRequests'
import { commitStudioDetach } from '@site/studio/studioStructuralCommits'
import { resolveActiveTreeTarget } from './helpers'
import { applyToThisInstanceOnly } from './instanceOnlyGesture'
import type { DetachInstancesOutcome, InstanceDetachConfirmState, InstanceDetachSlice } from './instanceDetachTypes'
import { presentStructuralRefusal, STRUCTURAL_REFUSAL_TITLE } from './structuralSourceEdits'
import type { SiteSliceHelpers } from './types'

const INSTANCE_MODULE_ID = 'studio.instance'

type InstanceActions = Pick<InstanceDetachSlice, 'detachInstances' | 'resolveInstanceDetachConfirm'>

type DetachDetail = NonNullable<StudioSaveResponse['detachDetails']>[number]

/** One call site a detach writes: the instance the user pointed at, and where its JSX is. */
interface DetachTarget {
  /** The node the user selected (a row's own `…#2` id, for a row). */
  nodeId: string
  /** The call site's own `rel:line:col` — for a row, its template's. */
  site: string
  label: string
  /** How many rows the call site renders: 1 unless it is a `.map` template. */
  rows: number
}

function instanceLabel(node: PageNode): string {
  const name = (node.props as { componentName?: unknown }).componentName
  return typeof name === 'string' && name ? name : (node.label ?? 'instance')
}

function isPackageInstance(node: PageNode): boolean {
  return (node.props as { source?: unknown }).source === 'package'
}

/** Rows of one `.map` template on the board — the N in "every row (N)". */
function rowsOf(tree: NodeTree<PageNode>, template: string): number {
  let rows = 0
  for (const id of Object.keys(tree.nodes)) if (loopTemplateNodeId(id) === template) rows += 1
  return Math.max(rows, 1)
}

/** Bottom-up by source position, so a reader of the sequence sees the order the file does not shift under. */
function bottomUp(a: DetachTarget, b: DetachTarget): number {
  const x = decodeSourceNodeId(a.site)
  const y = decodeSourceNodeId(b.site)
  if (!x || !y) return 0
  return x.rel.localeCompare(y.rel) || y.line - x.line || y.col - x.col
}

/** The sentences a confirm shows for `detail` — empty when nothing is lost. */
function lossSentences(target: DetachTarget, detail: DetachDetail, prefix: boolean): string[] {
  const lead = prefix ? `${target.label}: ` : ''
  const out: string[] = []
  if (detail.perRow) out.push(`${lead}this changes every row of the list (${target.rows}) — one piece of code renders them all.`)
  if (detail.branchNote) out.push(`${lead}${target.label} has more than one state; only the one on the canvas is kept.`)
  if (detail.movedHooks.length > 0) {
    out.push(`${lead}${detail.movedHooks.map((hook) => `${hook}()`).join(', ')} moves into the component around it.`)
  }
  return out
}

function warn(title: string, body: string): void {
  pushToast({ kind: 'warning', title, body, location: 'site-editor' })
}

export function createInstanceActions(helpers: SiteSliceHelpers): InstanceActions {
  const { get, set } = helpers
  /** The open confirm's answer — one at a time; a new confirm answers the old one "no". */
  let answerConfirm: ((confirmed: boolean) => void) | null = null

  function askToConfirm(state: InstanceDetachConfirmState): Promise<boolean> {
    answerConfirm?.(false)
    return new Promise((resolve) => {
      answerConfirm = resolve
      set((draft) => {
        draft.instanceDetachConfirm = state
      })
    })
  }

  function presentRefusal(refusal: { reason: string; message: string }, target: DetachTarget): void {
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.detach, explainDetachConstraint(refusal.reason, refusal.message), {
      // The CALL SITE, not a row's id: the remedy (a component copy) repoints one call site.
      nodeId: target.site,
      getState: get,
      set,
    })
  }

  /** What a landed/refused/held answer means — and the refusal, shown, when there is one. */
  function settle(answer: StudioSaveResponse | null, targets: readonly DetachTarget[]): DetachInstancesOutcome | DetachDetail[] {
    if (!answer) return 'refused'
    const refusal = answer.refusals?.[0]
    if (refusal) {
      presentRefusal(refusal, targets.find((target) => target.site === refusal.nodeId) ?? targets[0]!)
      return 'refused'
    }
    if (answer.written > 0) return 'detached'
    return answer.detachDetails ?? []
  }

  async function confirmLosses(targets: readonly DetachTarget[], details: readonly DetachDetail[]): Promise<boolean> {
    const losses = targets.flatMap((target) => {
      const detail = details.find((entry) => entry.nodeId === target.site)
      return detail ? lossSentences(target, detail, targets.length > 1) : []
    })
    if (losses.length === 0) return true
    const title = targets.length === 1 ? `Detach ${targets[0]!.label}?` : `Detach ${targets.length} instances?`
    return askToConfirm({ title, losses })
  }

  async function detachOne(target: DetachTarget): Promise<DetachInstancesOutcome> {
    const label = `Detach ${target.label}`
    const first = settle(await commitStudioDetach([{ kind: 'detach', nodeId: target.site, dryRun: 'if-lossy' }], label), [target])
    if (typeof first === 'string') return first
    if (!(await confirmLosses([target], first))) return 'cancelled'
    const second = settle(await commitStudioDetach([{ kind: 'detach', nodeId: target.site }], label), [target])
    return typeof second === 'string' ? second : 'refused'
  }

  async function detachMany(targets: readonly DetachTarget[]): Promise<DetachInstancesOutcome> {
    const ordered = [...targets].sort(bottomUp)
    let preview: StudioSaveResponse
    try {
      await flushEditorSave()
      preview = await postEdits(
        ordered.map((target) => ({ kind: 'detach', nodeId: target.site, dryRun: 'always' })),
        captureIdentities(ordered.map((target) => target.site)),
      )
    } catch (err) {
      console.error('[instanceActions] detach preview failed:', err)
      warn('Detach refused', getErrorMessage(err, 'Studio could not reach your project. Nothing was written.'))
      return 'refused'
    }
    const previewed = settle(preview, ordered)
    if (typeof previewed === 'string') return previewed
    if (!(await confirmLosses(ordered, previewed))) return 'cancelled'
    const label = `Detach ${ordered.length} instances`
    const written = settle(await commitStudioDetach(ordered.map((target) => ({ kind: 'detach', nodeId: target.site })), label), ordered)
    return typeof written === 'string' ? written : 'refused'
  }

  /** OD-7 — an instance inside another component's markup: detach the enclosing one, then this one; one ⌘Z. */
  function detachNested(nodeId: string, label: string): DetachInstancesOutcome {
    const tookOver = applyToThisInstanceOnly({
      get,
      set,
      refusedNodeId: nodeId,
      retry: (mapId) => void actions.detachInstances([mapId(nodeId)]),
      onRefused: () => warn('Detach refused', `The component around this ${label} could not be detached, so nothing was changed.`),
      componentCopy: false,
    })
    if (tookOver) return 'handed-off'
    warn(
      'Detach refused',
      `This ${label} sits inside a component that renders more than one root element, so it cannot be detached on its own. Detach that component first.`,
    )
    return 'refused'
  }

  async function runDetach(nodeIds: readonly string[]): Promise<DetachInstancesOutcome> {
    const tree = resolveActiveTreeTarget(get())?.tree
    if (!tree) return 'nothing'
    const ids = [...new Set(nodeIds)].filter((id) => tree.nodes[id]?.moduleId === INSTANCE_MODULE_ID)
    if (ids.length === 0) return 'nothing'

    const packaged = ids.find((id) => isPackageInstance(tree.nodes[id]!))
    if (packaged) {
      warn('Detach refused', `${instanceLabel(tree.nodes[packaged]!)} comes from a package, and detaching a package component is not available yet.`)
      return 'refused'
    }

    const nested = ids.find((id) => isInlinedNodeId(id))
    if (nested) {
      if (ids.length > 1) {
        warn('Detach refused', 'An instance inside another component is detached on its own. Select just that one and detach again.')
        return 'refused'
      }
      return detachNested(nested, instanceLabel(tree.nodes[nested]!))
    }

    const targets = new Map<string, DetachTarget>()
    for (const id of ids) {
      const site = hasWritableSourceLocation(id) ? id : loopTemplateNodeId(id)
      const label = instanceLabel(tree.nodes[id]!)
      if (!site) {
        warn('Detach refused', `This ${label} has no single place in your code to detach.`)
        return 'refused'
      }
      if (!targets.has(site)) targets.set(site, { nodeId: id, site, label, rows: site === id ? 1 : rowsOf(tree, site) })
    }
    const list = [...targets.values()]
    return list.length === 1 ? detachOne(list[0]!) : detachMany(list)
  }

  const actions: InstanceActions = {
    detachInstances: (nodeIds) =>
      new Promise((resolve) => {
        // A detach pressed while another structural write is on the wire runs
        // next, against the ids that write's resync leaves behind.
        const queued = deferWhileStructuralCommitInFlight((relocate) => {
          void actions.detachInstances(nodeIds.map(relocate)).then(resolve)
        }, nodeIds)
        if (!queued) void runDetach(nodeIds).then(resolve)
      }),

    resolveInstanceDetachConfirm: (confirmed) => {
      const answer = answerConfirm
      answerConfirm = null
      set((draft) => {
        draft.instanceDetachConfirm = null
      })
      answer?.(confirmed)
    },
  }
  return actions
}
