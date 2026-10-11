/**
 * instanceOverrideActions — OD-19: editing a value inside a shared component
 * changes ONLY that instance. The store half.
 *
 * `updateNodeProps` and `setNodeInlineStyles` ask {@link InstanceOverrideRouter.route}
 * before they mutate. For a node inside a component instance whose changed
 * values are literals in the component's own markup (`instanceOverridePlan.ts`
 * decides), the edit is not the ordinary tree-diff write — which would rewrite
 * the component and, with it, every other instance — but `expose-prop`:
 *
 *   1. the canvas shows the new value at once, as an OPTIMISTIC PREVIEW
 *      (`previewActiveTreeMutation`: outside undo history and dirty tracking,
 *      so it is neither a second undo step nor something autosave tries to
 *      persist);
 *   2. the values are HELD (`instanceOverrideHold.ts`) so the autosave diff —
 *      which the commit even flushes first — cannot write them to the
 *      component behind the override's back;
 *   3. `expose-prop` adds an optional prop per value to the component, its
 *      default the value that was there, and passes the new one at this call
 *      site. One gesture, two files, one journal entry: ⌘Z is `restore`, and
 *      every other instance renders byte-identical;
 *   4. an info toast says so and offers "Apply to all (N)" — `promote-override`,
 *      which writes the value into the component's default instead.
 *
 * When the server cannot prove the other instances stay identical (a spread at
 * a call site, a `.map` over props, a props type it cannot extend) the preview
 * is taken back and the edit is applied the ordinary way, with one sentence
 * saying it changed every instance and why: today's behaviour, never a silent
 * partial one. An edit the plan already knows is whole-component does the same
 * before anything is posted.
 *
 * "Edit main component" (`mainEditComponent`) is the explicit all-instances
 * mode: while it names the node's component, the router steps aside.
 *
 * Posts edits, never mints a tree: `no-vc-mode-branches-in-mutations` does not
 * apply (the posture `instanceActions.ts` has).
 */
import { callSitePosition, isInlinedNodeId, type NodeTree, type PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { pushToast } from '@ui/components/Toast'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { getLoadedNodeValues } from '@site/studio/loadedValuesBaseline'
import { holdInstanceOverride } from '@site/studio/instanceOverrideHold'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { StudioSaveResponse } from '@site/studio/studioSaveRequests'
import { commitStudioInstanceOverride, commitStudioPromoteOverride, type InstanceOverrideWire } from '@site/studio/studioInstanceOverrideCommits'
import { resolveActiveTreeTarget } from './helpers'
import { inlineTailKey } from './nodeIndex'
import { planInstanceOverride, refusalSentence, type OverrideChange, type PlannedOverride } from './instanceOverridePlan'
import type { InstanceOverrideSlice } from './instanceOverrideTypes'
import type { OptimisticPreviewHandle } from './structuralOptimism'
import type { SiteSliceHelpers } from './types'

/** What a store action hands the router: the edit, how to show it, and the ordinary write to fall back to. */
export interface InstanceOverrideRequest {
  nodeId: string
  change: OverrideChange
  /** Apply the edit to a tree draft (the same mutation the ordinary write makes), for the canvas preview. */
  preview: (tree: NodeTree<PageNode>) => boolean
  /** The ordinary write: the tree edit that autosave then diffs into the component. */
  plain: () => void
  /** Run the whole action again against `nodeId` (a gesture parked behind another write is re-aimed). */
  again: (nodeId: string) => void
}

export interface InstanceOverrideRouter {
  /** True when the router took the edit over (and will apply it, or its fallback, itself). */
  route: (request: InstanceOverrideRequest) => boolean
}

/** The refusals the codemod gives for "cannot prove the others stay identical" — the edit then falls back to the ordinary write. */
const FALLBACK_REASONS = new Set(['not-a-literal', 'maps-over-props', 'call-site-spread', 'unsupported-params', 'unsupported-props-type', 'unresolvable', 'package-component', 'not-in-component', 'no-source-location'])

function wireOf(override: PlannedOverride): InstanceOverrideWire {
  return { target: override.target, propName: override.propName, value: override.value }
}

export function createInstanceOverrideActions(helpers: SiteSliceHelpers): {
  router: InstanceOverrideRouter
  slice: Pick<InstanceOverrideSlice, 'setMainEditComponent'>
} {
  const { get, set, previewActiveTreeMutation } = helpers

  function findNode(nodeId: string): PageNode | undefined {
    const state = get()
    const active = resolveActiveTreeTarget(state)?.tree.nodes[nodeId]
    return active ?? state.site?.pages.find((page) => page.nodes[nodeId])?.nodes[nodeId]
  }

  function callSiteKeys(callSiteId: string): string[] {
    const props = findNode(callSiteId)?.props as { callSiteProps?: Record<string, unknown> } | undefined
    return Object.keys(props?.callSiteProps ?? {})
  }

  function instancesOnBoard(nodeId: string): number {
    const tail = inlineTailKey(nodeId)
    return tail ? (get()._inlineTailToCount.get(tail) ?? 1) : 1
  }

  /** Apply to all (N): the override becomes the component's default, then the call site passes nothing. */
  async function applyToAll(callSiteId: string, propNames: readonly string[], componentName: string): Promise<void> {
    const instance = findNode(callSiteId)
    const element = instance?.children[0]
    if (!instance || element === undefined || !isInlinedNodeId(element)) {
      pushToast({
        kind: 'warning',
        title: 'Could not apply to every instance',
        body: `That ${componentName} moved on the board. Select it and use the component's own controls.`,
        location: 'site-editor',
      })
      return
    }
    await commitStudioPromoteOverride({ nodeId: element, propNames }, `Apply to all ${componentName}`)
    invalidateLocalComponentCatalog()
  }

  function announceInstanceOnly(nodeId: string, componentName: string, beforeKeys: readonly string[]): void {
    const callSiteId = callSitePosition(nodeId)
    const count = instancesOnBoard(nodeId)
    const before = new Set(beforeKeys)
    const propNames = callSiteKeys(callSiteId).filter((key) => !before.has(key))
    const others = count - 1
    pushToast({
      kind: 'info',
      title: `Changed on this ${componentName} only`,
      ...(others > 0 ? { body: `The other ${others} ${others === 1 ? 'place' : 'places'} on the board stay as they were.` } : {}),
      location: 'site-editor',
      durationMs: 9000,
      dedupeKey: `instance-override:${callSiteId}`,
      ...(others > 0 && propNames.length > 0
        ? { action: { label: `Apply to all (${count})`, onSelect: () => deferredApplyToAll(callSiteId, propNames, componentName) } }
        : {}),
    })
  }

  function deferredApplyToAll(callSiteId: string, propNames: readonly string[], componentName: string): void | Promise<void> {
    return new Promise<void>((resolve) => {
      const queued = deferWhileStructuralCommitInFlight((relocate) => {
        void applyToAll(relocate(callSiteId), propNames, componentName).then(resolve)
      }, [callSiteId])
      if (!queued) void applyToAll(callSiteId, propNames, componentName).then(resolve)
    })
  }

  function announceWholeComponent(sentence: string): void {
    pushToast({ kind: 'info', title: 'Not limited to this instance', body: sentence, location: 'site-editor', dedupeKey: `instance-override-whole:${sentence}` })
  }

  /** The ordinary write, after the override could not be made. A page re-read in the meantime may have removed the node. */
  function writeOrdinarily(request: InstanceOverrideRequest): void {
    try {
      request.plain()
    } catch (err) {
      console.error('[instanceOverrideActions] the ordinary write after a refused override failed:', err)
    }
  }

  async function runOverride(request: InstanceOverrideRequest, overrides: PlannedOverride[], componentName: string): Promise<void> {
    const { nodeId } = request
    const rollbackPreview = previewActiveTreeMutation((tree) => request.preview(tree))
    // Nothing changed on the tree: the ordinary write has nothing to do either.
    if (!rollbackPreview) return

    const release = holdInstanceOverride(nodeId, overrides.map((override) => override.key))
    const beforeKeys = callSiteKeys(callSitePosition(nodeId))
    const outcome: { answer: StudioSaveResponse | null; landed: boolean } = { answer: null, landed: false }
    const handle: OptimisticPreviewHandle = { nodeIds: [], rollback: rollbackPreview, settle: () => undefined }
    try {
      await commitStudioInstanceOverride({ nodeId, overrides: overrides.map(wireOf) }, `Edit ${componentName}`, {
        optimistic: handle,
        onAnswer: (received) => {
          outcome.answer = received
        },
        onLanded: () => {
          outcome.landed = true
        },
      })
    } finally {
      release()
    }

    if (outcome.landed) {
      // The component gained optional props: its Component-section rows are read from the catalog.
      invalidateLocalComponentCatalog()
      announceInstanceOnly(nodeId, componentName, beforeKeys)
      return
    }
    // No answer at all: the engine has already taken the preview back and said so.
    const refusal = outcome.answer?.refusals?.[0]
    if (!refusal) return
    // A value that is already a prop has no ordinary write to fall back to (the markup holds `{prop}`, which the
    // ordinary write refuses as code): the server's own sentence is the answer.
    const sentence = FALLBACK_REASONS.has(refusal.reason) && !overrides.some((override) => override.fed) ? refusalSentence(refusal.reason, componentName) : null
    if (sentence === null) {
      pushToast({ kind: 'warning', title: 'Could not change this instance', body: refusal.message, location: 'site-editor' })
      return
    }
    writeOrdinarily(request)
    announceWholeComponent(sentence)
  }

  const router: InstanceOverrideRouter = {
    route: (request) => {
      const state = get()
      const target = resolveActiveTreeTarget(state)
      if (!target || target.vc) return false
      const node = target.tree.nodes[request.nodeId]
      if (!node || !isInlinedNodeId(request.nodeId)) return false
      if (state.mainEditComponent !== null && state.mainEditComponent === node.fromComponent) return false

      const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
      const plan = planInstanceOverride({
        node,
        nodeId: request.nodeId,
        change: request.change,
        textProp,
        baseline: getLoadedNodeValues(request.nodeId),
        callSite: findNode(callSitePosition(request.nodeId)),
      })
      if (plan.kind === 'direct') return false
      if (plan.kind === 'whole-component') {
        request.plain()
        announceWholeComponent(plan.reason)
        return true
      }
      // A write is on the wire: this gesture waits for it, then is aimed at
      // the element it named (the write renumbered the file).
      if (deferWhileStructuralCommitInFlight((relocate) => request.again(relocate(request.nodeId)), [request.nodeId])) return true
      void runOverride(request, plan.overrides, node.fromComponent ?? 'component')
      return true
    },
  }

  return {
    router,
    slice: {
      setMainEditComponent: (componentName) => {
        set((draft) => {
          draft.mainEditComponent = componentName
        })
      },
    },
  }
}
