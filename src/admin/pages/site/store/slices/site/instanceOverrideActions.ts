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
 * "Edit main component" (`mainEditTarget`, `mainEditMode.ts`) is the explicit
 * all-instances mode: while it names the node's component, the router steps
 * aside.
 *
 * Posts edits, never mints a tree: `no-vc-mode-branches-in-mutations` does not
 * apply (the posture `instanceActions.ts` has).
 */
import { callSitePosition, inlineDepth, isInlinedNodeId, styleValueKey, type CSSPropertyBag, type NodeTree, type PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { pushToast } from '@ui/components/Toast'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { getLoadedNodeValues } from '@site/studio/loadedValuesBaseline'
import { holdInstanceOverride } from '@site/studio/instanceOverrideHold'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { StudioSaveResponse } from '@site/studio/studioSaveRequests'
import { getStudioStyleRuleSources } from '@site/studio/cssInsertDestination'
import { atRuleForContext } from '@site/studio/styleRuleWriteback'
import { commitStudioClassOverride, commitStudioInstanceOverride, commitStudioPromoteClassOverride, commitStudioPromoteOverride, type InstanceOverrideWire } from '@site/studio/studioInstanceOverrideCommits'
import { resolveActiveTreeTarget } from './helpers'
import { inlineTailKey } from './nodeIndex'
import { planInstanceOverride, refusalSentence, type OverrideChange, type PlannedOverride } from './instanceOverridePlan'
import { CLASS_FALLBACK_REASONS, classRefusalSentence, planClassOverride, type ClassOverrideEdit } from './classOverridePlan'
import type { ClassOverrideRequest, InstanceOverrideSlice } from './instanceOverrideTypes'
import { isEditingComponent } from './mainEditMode'
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

/**
 * "Edit main component" writes the component's own markup, and a value that is
 * a prop (`{heading}`) has no literal there to write: its home is an instance's
 * call site, or the default in the code. Say so instead of sending a write the
 * server would refuse. True when this edit touches such a value (and was answered).
 */
function declinesFedEdit(node: PageNode, change: OverrideChange): boolean {
  const feeds = node.propFeeds
  if (!feeds) return false
  const touched = [...Object.keys(change.props ?? {}), ...Object.keys(change.styles ?? {}).map(styleValueKey)].find((key) => feeds[key] !== undefined)
  if (touched === undefined) return false
  pushToast({
    kind: 'info',
    title: 'Set by a prop',
    body: `${node.fromComponent ?? 'This component'} takes this value as \`${feeds[touched]}\`. Change it on an instance, or its default in the code.`,
    location: 'site-editor',
    dedupeKey: `instance-fed-main:${node.id}:${touched}`,
  })
  return true
}

export function createInstanceOverrideActions(helpers: SiteSliceHelpers): {
  router: InstanceOverrideRouter
  slice: Pick<InstanceOverrideSlice, 'setVariantEditAxis' | 'overrideClassOnInstance' | 'instanceClassEditIsLocal'>
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

  /** How many places "Apply to all" reaches: the page's component is what gains the default, wherever it is used. */
  function instancesOnBoard(nodeId: string): number {
    if (inlineDepth(nodeId) > 1) {
      const instance = findNode(callSitePosition(nodeId))?.props as { componentName?: string; sourceFile?: string } | undefined
      if (!instance) return 1
      let count = 0
      for (const page of get().site?.pages ?? []) {
        for (const node of Object.values(page.nodes)) {
          const props = node.moduleId === 'studio.instance' ? (node.props as { componentName?: string; sourceFile?: string }) : undefined
          if (props !== undefined && props.componentName === instance.componentName && props.sourceFile === instance.sourceFile) count += 1
        }
      }
      return Math.max(count, 1)
    }
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

  // --- G-2b: a class edit made inside one instance -------------------------------------------------------------

  /** The instance (call site) an inlined element is the root of. */
  function instanceOf(tree: NodeTree<PageNode>, nodeId: string): PageNode | undefined {
    return Object.values(tree.nodes).find((candidate) => candidate.moduleId === 'studio.instance' && candidate.children.includes(nodeId))
  }

  function classPlanFor(request: ClassOverrideRequest) {
    const state = get()
    const target = resolveActiveTreeTarget(state)
    if (!target || target.vc) return null
    const node = target.tree.nodes[request.nodeId]
    if (!node || !isInlinedNodeId(request.nodeId)) return null
    if (isEditingComponent(state.mainEditTarget, node.fromComponent)) return null
    const atRule =
      request.contextId === null
        ? undefined
        : atRuleForContext(request.contextId, { ...(state.site?.breakpoints ? { breakpoints: state.site.breakpoints } : {}), ...(state.site?.conditions ? { conditions: state.site.conditions } : {}) })
    const plan = planClassOverride({ nodeId: request.nodeId, node, instance: instanceOf(target.tree, request.nodeId), source: getStudioStyleRuleSources()[request.classId], atRule, patch: request.patch })
    return { node, plan }
  }

  /** The ordinary class write, after the override could not be made. */
  function writeClassOrdinarily(request: ClassOverrideRequest): void {
    try {
      const patch = request.patch as Partial<CSSPropertyBag>
      if (request.contextId) get().setClassContextStyles(request.classId, request.contextId, patch)
      else get().updateClassStyles(request.classId, patch)
    } catch (err) {
      console.error('[instanceOverrideActions] the ordinary class write after a refused override failed:', err)
    }
  }

  async function applyClassToAll(callSiteId: string, edit: ClassOverrideEdit, componentName: string): Promise<void> {
    const element = findNode(callSiteId)?.children[0]
    if (element === undefined || !isInlinedNodeId(element)) {
      pushToast({ kind: 'warning', title: 'Could not apply to every instance', body: `That ${componentName} moved on the board. Select it and use the component's own controls.`, location: 'site-editor' })
      return
    }
    await commitStudioPromoteClassOverride({ nodeId: element, file: edit.file, selector: edit.selector, properties: Object.keys(edit.declarations), ...(edit.atRule !== undefined ? { atRule: edit.atRule } : {}) }, `Apply to all ${componentName}`)
    invalidateLocalComponentCatalog()
  }

  function announceClassOnly(nodeId: string, edit: ClassOverrideEdit, componentName: string): void {
    const callSiteId = callSitePosition(nodeId)
    const count = instancesOnBoard(nodeId)
    const others = count - 1
    pushToast({
      kind: 'info',
      title: `Changed on this ${componentName} only`,
      ...(others > 0 ? { body: `The other ${others} ${others === 1 ? 'place' : 'places'} on the board stay as they were.` } : {}),
      location: 'site-editor',
      durationMs: 9000,
      dedupeKey: `instance-class-override:${callSiteId}`,
      ...(others > 0
        ? {
            action: {
              label: `Apply to all (${count})`,
              onSelect: () =>
                new Promise<void>((resolve) => {
                  const queued = deferWhileStructuralCommitInFlight((relocate) => void applyClassToAll(relocate(callSiteId), edit, componentName).then(resolve), [callSiteId])
                  if (!queued) void applyClassToAll(callSiteId, edit, componentName).then(resolve)
                }),
            },
          }
        : {}),
    })
  }

  async function runClassOverride(request: ClassOverrideRequest, edit: ClassOverrideEdit): Promise<void> {
    const { nodeId } = request
    const componentName = findNode(nodeId)?.fromComponent ?? 'component'
    const styles = Object.fromEntries(Object.entries(request.patch).map(([property, value]) => [property, String(value)]))
    // The canvas shows the instance's new look at once, as an inline preview (outside history and dirty tracking): the
    // shared class is not touched, so no other instance moves while the write is on the wire.
    const rollbackPreview = previewActiveTreeMutation((tree) => {
      const element = tree.nodes[nodeId]
      if (!element) return false
      element.inlineStyles = { ...element.inlineStyles, ...styles }
      return true
    })
    if (!rollbackPreview) return
    const release = holdInstanceOverride(nodeId, Object.keys(styles).map(styleValueKey))
    const outcome: { answer: StudioSaveResponse | null; landed: boolean } = { answer: null, landed: false }
    const handle: OptimisticPreviewHandle = { nodeIds: [], rollback: rollbackPreview, settle: () => undefined }
    try {
      await commitStudioClassOverride({ nodeId, ...edit }, `Edit ${componentName}`, {
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
      invalidateLocalComponentCatalog()
      announceClassOnly(nodeId, edit, componentName)
      return
    }
    const refusal = outcome.answer?.refusals?.[0]
    if (!refusal) return
    const sentence = CLASS_FALLBACK_REASONS.has(refusal.reason) ? classRefusalSentence(refusal.reason, componentName) : null
    if (sentence === null) {
      pushToast({ kind: 'warning', title: 'Could not change this instance', body: refusal.message, location: 'site-editor' })
      return
    }
    writeClassOrdinarily(request)
    announceWholeComponent(sentence)
  }

  const overrideClassOnInstance: InstanceOverrideSlice['overrideClassOnInstance'] = (request) => {
    const planned = classPlanFor(request)
    if (!planned || planned.plan.kind === 'direct') return false
    if (planned.plan.kind === 'whole-component') {
      announceWholeComponent(planned.plan.reason)
      return false
    }
    const { edit } = planned.plan
    // A write is on the wire: this gesture waits for it, then is aimed at the element it named.
    if (deferWhileStructuralCommitInFlight((relocate) => void runClassOverride({ ...request, nodeId: relocate(request.nodeId) }, edit), [request.nodeId])) return true
    void runClassOverride(request, edit)
    return true
  }

  const instanceClassEditIsLocal: InstanceOverrideSlice['instanceClassEditIsLocal'] = (nodeId, classId) =>
    classPlanFor({ nodeId, classId, patch: { preview: 'x' }, contextId: null })?.plan.kind === 'override'

  const router: InstanceOverrideRouter = {
    route: (request) => {
      const state = get()
      const target = resolveActiveTreeTarget(state)
      if (!target || target.vc) return false
      const node = target.tree.nodes[request.nodeId]
      if (!node || !isInlinedNodeId(request.nodeId)) return false
      if (isEditingComponent(state.mainEditTarget, node.fromComponent)) return declinesFedEdit(node, request.change)

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
      overrideClassOnInstance,
      instanceClassEditIsLocal,
      setVariantEditAxis: (prop) => {
        set((draft) => {
          draft.variantEditAxis = prop
        })
      },
    },
  }
}
