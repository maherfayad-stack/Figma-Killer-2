/**
 * The structural gestures that, on a studio-imported tree, are a SOURCE WRITE
 * rather than a tree mutation: insert, duplicate, wrap, (K3) group and
 * ungroup, and (`store-13`) paste.
 *
 * `struct-02` shipped the first one and W4-1 added the other two, at which
 * point they stopped being a detail of `nodeActions.ts` and became a thing of
 * their own — the module-size gate said so first, and it was right. Every one
 * of them has the identical shape, and the shape IS the contract:
 *
 *   1. Ask `structuralSourceEdits.ts` whether the source can take the gesture.
 *   2. Refused → toast the constraint and STOP. Nothing changes on the canvas,
 *      because nothing changed in the file.
 *   3. No commit → this is an ordinary CMS tree; return `false` so the caller
 *      takes its normal in-memory path, untouched.
 *   4. Otherwise → post the write and STOP. The board is NOT updated here and
 *      no node id is returned, because there is no honest one to return: the
 *      element does not exist until the codemod has written it, and its id is
 *      the `line:col` that write produces. The commit's own reload is what
 *      brings it in.
 *
 * Step 4 is why these return `true` for both outcomes — written and refused.
 * Either way the caller must not mint anything.
 *
 * `store-13` — the new element is nonetheless SELECTED once it arrives. The
 * save route reports the ids it created and `commitStructural` hands them to
 * the resync that reads the write back (`pendingStructuralOutcome.ts`), so "no id to return
 * here" no longer means "the gesture's result is never pointed at".
 *
 * The wrapper/element spelling comes from the MODULE REGISTRY
 * (`sourceImport` / `sourceIntrinsic`), never from a hardcoded design system,
 * so a project with its own component library writes its own components.
 */
import { registry } from '@core/module-engine'
import { describeStructuralRefusal, type NodeTree, type PageNode } from '@core/page-tree'
import { broadcastOptimisticInsert } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import {
  commitStudioDuplicate,
  commitStudioDuplicateTo,
  commitStudioGroup,
  commitStudioInsert,
  commitStudioUngroup,
  commitStudioWrap,
} from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight, type RelocateNodeId } from '@site/studio/structuralCommitQueue'
import {
  STRUCTURAL_REFUSAL_TITLE,
  planSourceDuplicate,
  planSourceDuplicateTo,
  planSourceGroup,
  planSourceInsert,
  planSourceUngroup,
  planSourceWrap,
  presentStructuralRefusal,
} from './structuralSourceEdits'
import { insertableJsxProps } from './insertablePropValues'
import { createStudioSourceRefusals, type StudioSourceRefusals } from './studioSourceRefusals'
import {
  previewOptimisticDuplicate,
  previewOptimisticGroup,
  previewOptimisticInsert,
  previewOptimisticWrap,
} from './structuralOptimism'
import type { SiteSliceHelpers } from './types'

/**
 * The writers, plus the two pre-write questions `studioSourceRefusals.ts`
 * answers — one front door, so no call site had to learn about the split.
 */
export interface StudioSourceWrites extends StudioSourceRefusals {
  /** True when the caller must stop: the element was written to source, or the write was refused out loud. */
  writeInsertToSource: (
    moduleId: string,
    defaults: Record<string, unknown> | undefined,
    parentId: string,
    index?: number,
    /** React-style inline styles written into the new element's own `style={{ … }}`. */
    inlineStyles?: Record<string, string>,
  ) => boolean
  /**
   * `destination` (K2 — Alt+drag) puts the copy INSIDE a container instead of
   * beside the original. Omitted for ⌘D and the toolbar button.
   */
  writeDuplicateToSource: (
    nodeIds: readonly string[],
    destination?: { parentId: string; index: number },
  ) => boolean
  writeWrapToSource: (
    nodeIds: readonly string[],
    containerModuleId: string,
    defaults: Record<string, unknown>,
  ) => boolean
  /** K3 - Cmd+G: one container around a contiguous run of siblings (or the single-element `wrap`). */
  writeGroupToSource: (
    nodeIds: readonly string[],
    containerModuleId: string,
    defaults: Record<string, unknown>,
  ) => boolean
  /** K3 - Cmd+Shift+G: a container dissolved, its children taking its place. */
  writeUngroupToSource: (nodeId: string) => boolean
}


/**
 * `readTree` is passed in rather than re-derived: `nodeActions.ts` already has
 * it (the active tree, read-only, resolved through `resolveActiveTreeTarget`),
 * and every guard here has to answer BEFORE any mutation runs — a refusal that
 * arrives from inside a Mutative recipe has already changed the document it is
 * refusing.
 */
export function createStudioSourceWrites(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
): StudioSourceWrites {
  const { get, set } = helpers
  const refusals = createStudioSourceRefusals(helpers, readTree)

  /**
   * Adds a module to a studio-imported tree by writing it to the user's source
   * instead of mutating the tree, or `false` when this is an ordinary CMS tree
   * that should take the normal in-memory path.
   *
   * The board is NOT updated here and no node id is returned, because there is
   * no honest one to return: the element does not exist until the codemod has
   * written it, and its id is the `line:col` that write produces. The commit
   * reloads on every outcome, which is what brings the new node in — the same
   * "one-shot commit, then re-sync with disk" shape `move`/`delete` use, minus
   * the optimistic mutation they can afford and this cannot.
   */
  const writeInsertToSource = (
    moduleId: string,
    defaults: Record<string, unknown> | undefined,
    parentId: string,
    index?: number,
    inlineStyles?: Record<string, string>,
  ): boolean => {
    // `store-14` — a second structural gesture fired while a prior one is
    // still being written+resynced runs NEXT rather than being refused. It is
    // parked as a thunk and re-planned against the tree that commit's resync
    // leaves behind; see `structuralCommitQueue.ts`.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writeInsertToSource(moduleId, defaults, relocate(parentId), index, inlineStyles)
      }, [parentId])
    ) {
      return true
    }
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceInsert(tree, parentId, index)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
        nodeId: plan.nodeId,
        // The refused node here is the CONTAINER (`parentId`) — re-issue the
        // same insert against whatever replaces it once detach/extract lands.
        retry: (newParentId) => writeInsertToSource(moduleId, defaults, newParentId, index, inlineStyles),
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write

    const mod = registry.get(moduleId)
    const props = { ...(mod?.defaults ?? {}), ...(defaults ?? {}) }
    const sourceImport = mod?.sourceImport

    if (sourceImport) {
      // `live-07`/`perf-10` — same-tick paint for BOTH frame kinds, sharing
      // ONE placeholder id: a throwaway `optimistic:` id stands in purely as
      // the bridge ghost's own `data-node-id` (safe because
      // `BridgeFrameAdapter.optimistic.insert` never looks it up, and
      // `runtime.ts`'s ghost sweep removes it wholesale on the next Fast
      // Refresh) AND as the temporary node's real id in the local tree, which
      // is what makes a PORTAL frame paint too — it renders from that tree,
      // not from a DOM ghost. `'div'` for the bridge ghost is the
      // least-disruptive generic placeholder tag; the local preview renders
      // the actual module with its own defaults instead, since a
      // design-system component's real ROOT TAG is unknowable without
      // executing it, but its registered CANVAS appearance is not.
      const ghostId = `optimistic:${crypto.randomUUID()}`
      broadcastOptimisticInsert(ghostId, plan.commit.parentNodeId, index ?? Number.MAX_SAFE_INTEGER, 'div')
      const optimistic =
        previewOptimisticInsert(helpers, moduleId, props, plan.commit.parentNodeId, index, ghostId) ?? undefined
      void commitStudioInsert({
        ...plan.commit,
        name: sourceImport.name,
        // The two spellings a registered component can have: a package names
        // its specifier, the built-in design system names only itself and the
        // SERVER computes the path relative to the file being written (the
        // editor does not know where that file sits — see `sourceImport`).
        ...(sourceImport.kind === 'package'
          ? { importSpecifier: sourceImport.specifier }
          : { designSystemImport: true as const }),
        props: insertableJsxProps(props),
        ...(optimistic ? { optimistic } : {}),
      })
      return true
    }

    // Still possibly a real element: `base.container` is a `<div>`/`<span>`,
    // `base.text` a `<p>` wrapping text. `insertJsxElement` writes those by
    // omitting `importSpecifier`. See `sourceIntrinsic` on `ModuleDefinition`.
    const intrinsic = mod?.sourceIntrinsic?.(props)
    if (intrinsic) {
      // `live-07`/`perf-10` — same as above, but an honest tag match:
      // `intrinsic.tag` is exactly what the codemod is about to write, and
      // `props` (the same merged bag the codemod's `intrinsic.text` was
      // itself derived from) is what the local preview renders with.
      const ghostId = `optimistic:${crypto.randomUUID()}`
      broadcastOptimisticInsert(ghostId, plan.commit.parentNodeId, index ?? Number.MAX_SAFE_INTEGER, intrinsic.tag, intrinsic.text)
      const optimistic =
        previewOptimisticInsert(helpers, moduleId, props, plan.commit.parentNodeId, index, ghostId, inlineStyles) ??
        undefined
      void commitStudioInsert({
        ...plan.commit,
        name: intrinsic.tag,
        // `K4` — a caller-supplied inline-style bag is written as part of THIS
        // element, not as a follow-up edit: the node does not exist until the
        // codemod runs, and its id is the `line:col` that write produces, so
        // there is nothing to style afterwards until the resync lands. Keys
        // are React-style camelCase (`borderRadius`), which is the spelling
        // `renderJsxNode` emits into `style={{ … }}` and the parser reads back.
        props: inlineStyles && Object.keys(inlineStyles).length > 0 ? { style: { ...inlineStyles } } : {},
        ...(intrinsic.text === undefined ? {} : { children: intrinsic.text }),
        ...(optimistic ? { optimistic } : {}),
      })
      return true
    }

    // Everything else is an editor construct with no spelling in a user's repo;
    // the picker hides those in studio mode, so this is the programmatic path.
    // Always `actions: []` — always the toast, never the dialog.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.insert,
      describeStructuralRefusal({
        refusal: {
          reason: 'insert',
          message: `"${mod?.name ?? moduleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write to the file. Add a design-system component instead.`,
        },
      }),
      { getState: get, set },
    )
    return true
  }

  /**
   * W4-1 — a duplicate on a studio-imported tree is a SOURCE write, not a tree
   * mutation: `duplicateJsxElement` copies the element's own text in as its next
   * sibling and the board re-reads it, so the copy arrives as a real parsed node
   * instead of a nanoid twin the next parse would delete. Returns true when the
   * caller must stop — written, or refused out loud; either way nothing is
   * minted here. Same shape as `writeInsertToSource`.
   */
  const writeDuplicateToSource = (
    nodeIds: readonly string[],
    destination?: { parentId: string; index: number },
  ): boolean => {
    // `store-11`/`store-14` — this is the exact gesture the race was found on:
    // a rapid double-click/keypress on Duplicate before the first click's
    // resync lands used to plan a SECOND duplicate against the still-unshifted
    // original, writing two real copies for one gesture. Serializing is still
    // what closes that; what changed is that the second press is QUEUED rather
    // than refused, and re-plans against the resynced tree when it runs — five
    // ⌘D presses are five copies, not one. K2's Alt+drag rides the identical
    // queue, for the identical reason.
    const relocateDestination = (relocate: RelocateNodeId) =>
      destination ? { ...destination, parentId: relocate(destination.parentId) } : undefined
    if (
      deferWhileStructuralCommitInFlight(
        (relocate) => { writeDuplicateToSource(nodeIds.map(relocate), relocateDestination(relocate)) },
        destination ? [...nodeIds, destination.parentId] : nodeIds,
      )
    ) {
      return true
    }
    const tree = readTree()
    if (!tree) return false

    const retryOn = (refusedNodeId: string | undefined) =>
      refusedNodeId
        ? (newNodeId: string) => {
            void writeDuplicateToSource(
              nodeIds.map((id) => (id === refusedNodeId ? newNodeId : id)),
              destination,
            )
          }
        : undefined

    // K2 — Alt+drag: the copy lands INSIDE a container the user pointed at,
    // which is a second question (`planSourceDuplicateTo`) rather than a flag
    // on the first. See that function for why the anchor is an insert's, not
    // a move's.
    if (destination) {
      const plan = planSourceDuplicateTo(tree, nodeIds, destination.parentId, destination.index)
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.duplicate, plan.constraint, {
          nodeId: plan.nodeId,
          retry: retryOn(plan.nodeId),
          getState: get,
          set,
        })
        return true
      }
      if (!plan.commit) return false // an ordinary CMS tree — nothing to write
      void commitStudioDuplicateTo(plan.commit)
      return true
    }

    const plan = planSourceDuplicate(tree, nodeIds)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.duplicate, plan.constraint, {
        nodeId: plan.nodeId,
        retry: retryOn(plan.nodeId),
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write
    // `perf-10` — paint the copies now, at the same identity `plan.commit`
    // names: `duplicateNodeWithScopedClasses` clones each source id locally
    // so the canvas shows the duplicate the instant ⌘D fires rather than
    // after the write's own resync.
    const optimistic = previewOptimisticDuplicate(helpers, plan.commit) ?? undefined
    void commitStudioDuplicate(plan.commit, optimistic)
    return true
  }

  /**
   * The wrap counterpart. The wrapper is spelled from the module registry the
   * same way an insert is (`sourceImport` for a design-system container,
   * `sourceIntrinsic` for a `<div>`), so nothing here is coupled to a particular
   * design system — and a module with neither spelling is an editor building
   * block with no form in a user's repo, which refuses by saying exactly that.
   */
  const writeWrapToSource = (nodeIds: readonly string[], containerModuleId: string, defaults: Record<string, unknown>): boolean => {
    // `store-14` — same queue as `writeDuplicateToSource`.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writeWrapToSource(nodeIds.map(relocate), containerModuleId, defaults)
      }, nodeIds)
    ) {
      return true
    }
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceWrap(tree, nodeIds)
    if (!plan.ok) {
      const refusedNodeId = plan.nodeId
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.wrap, plan.constraint, {
        nodeId: refusedNodeId,
        retry: refusedNodeId
          ? (newNodeId) => {
              void writeWrapToSource(
                nodeIds.map((id) => (id === refusedNodeId ? newNodeId : id)),
                containerModuleId,
                defaults,
              )
            }
          : undefined,
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write

    const container = resolveContainerTag(containerModuleId, defaults)
    if (container) {
      // `perf-10` — same defaults-resolution rule `nodeActions.ts`'s plain
      // `wrapNode` uses, so the local preview's wrapper renders correctly.
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const optimistic = previewOptimisticWrap(helpers, plan.commit, containerModuleId, resolvedDefaults) ?? undefined
      void commitStudioWrap({ nodeId: plan.commit, ...container, ...(optimistic ? { optimistic } : {}) })
      return true
    }
    // Always `actions: []` — always the toast, never the dialog.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.wrap,
      describeStructuralRefusal({
        refusal: {
          reason: 'wrap',
          message: `"${registry.get(containerModuleId)?.name ?? containerModuleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write around this element. Wrap it in a container instead.`,
        },
      }),
      { getState: get, set },
    )
    return true
  }

  /**
   * K3 — Cmd+G. The same shape as every other writer here, with one branch
   * the others do not have: a run of ONE is committed as the existing `wrap`
   * (`wrapJsxElement`, one element's own range) and a run of several as
   * `group` (`wrapJsxElements`, one container around one span). The two are
   * different writes, and the wire says which is meant rather than leaving the
   * server to infer it from the length of a list.
   *
   * The container is spelled from the MODULE REGISTRY exactly as `wrap` spells
   * it, so a project with its own component library groups into its own
   * component.
   */
  const writeGroupToSource = (
    nodeIds: readonly string[],
    containerModuleId: string,
    defaults: Record<string, unknown>,
  ): boolean => {
    if (nodeIds.length === 0) return false
    // `store-14` — same queue as `writeDuplicateToSource`: a held Cmd+G must
    // not plan a second group against the still-unshifted original, but it
    // must not be thrown away either.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writeGroupToSource(nodeIds.map(relocate), containerModuleId, defaults)
      }, nodeIds)
    ) {
      return true
    }
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceGroup(tree, nodeIds)
    if (!plan.ok) {
      const refusedNodeId = plan.nodeId
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.group, plan.constraint, {
        nodeId: refusedNodeId,
        retry: refusedNodeId
          ? (newNodeId) => {
              void writeGroupToSource(
                nodeIds.map((id) => (id === refusedNodeId ? newNodeId : id)),
                containerModuleId,
                defaults,
              )
            }
          : undefined,
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write

    const container = resolveContainerTag(containerModuleId, defaults)
    if (!container) {
      // Always `actions: []` — always the toast, never the dialog.
      presentStructuralRefusal(
        STRUCTURAL_REFUSAL_TITLE.group,
        describeStructuralRefusal({
          refusal: {
            reason: 'group',
            message: `"${registry.get(containerModuleId)?.name ?? containerModuleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write around these elements. Group them in a container instead.`,
          },
        }),
        { getState: get, set },
      )
      return true
    }

    // `perf-10` — same defaults-resolution rule `writeWrapToSource` uses.
    const mod = registry.get(containerModuleId)
    const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
    const only = plan.commit.length === 1 ? plan.commit[0] : undefined
    if (only !== undefined) {
      const optimistic = previewOptimisticWrap(helpers, only, containerModuleId, resolvedDefaults) ?? undefined
      void commitStudioWrap({ nodeId: only, ...container, ...(optimistic ? { optimistic } : {}) })
    } else {
      const optimistic = previewOptimisticGroup(helpers, plan.commit, containerModuleId, resolvedDefaults) ?? undefined
      void commitStudioGroup({ nodeIds: plan.commit, ...container, ...(optimistic ? { optimistic } : {}) })
    }
    return true
  }

  /**
   * K3 — Cmd+Shift+G. Nothing is mutated on the canvas first: an ungroup
   * re-parents every child, and the ids those children get afterwards are the
   * `line:col`s the write produces, so the commit's own resync is what brings
   * them in.
   */
  const writeUngroupToSource = (nodeId: string): boolean => {
    // `store-14` — same queue as the other source writers.
    if (deferWhileStructuralCommitInFlight((relocate) => { writeUngroupToSource(relocate(nodeId)) }, [nodeId])) return true
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceUngroup(tree, nodeId)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.ungroup, plan.constraint, {
        nodeId: plan.nodeId,
        retry: plan.nodeId ? (newNodeId) => { void writeUngroupToSource(newNodeId) } : undefined,
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write
    void commitStudioUngroup(plan.commit, restorableContainerSpelling(tree.nodes[plan.commit]))
    return true
  }

  return {
    ...refusals,
    writeInsertToSource,
    writeDuplicateToSource,
    writeWrapToSource,
    writeGroupToSource,
    writeUngroupToSource,
  }
}

/**
 * `store-14` — how to write this container back around its children, or `null`
 * when a re-wrap would not restore it.
 *
 * ⌘⇧G's undo is a ⌘G, and `wrapJsxElement`/`wrapJsxElements` write a BARE tag:
 * no `className`, no `style`, no `id`. So a wrapper carrying any of those
 * three is honestly un-undoable from the canvas — re-grouping would produce a
 * container that has quietly lost what the user put on it, which is the
 * half-applied write this store refuses everywhere else. The undo says so by
 * name instead (see `commitStudioUngroup`). Closing it needs `props` on the
 * `wrap`/`group` edit, which is the wrap codemod's own surface.
 *
 * `unwrapJsxElement` already refuses a COMPONENT wrapper (`has-behaviour`), so
 * everything that reaches here is an intrinsic tag the module registry can
 * spell from the node's own props — `base.container`'s `tag`/`customTag`.
 */
function restorableContainerSpelling(
  node: PageNode | undefined,
): { name: string; importSpecifier?: string; designSystemImport?: true } | null {
  if (!node) return null
  const carriesStyling =
    node.classIds.length > 0 ||
    Object.keys(node.inlineStyles ?? {}).length > 0 ||
    (typeof node.props.id === 'string' && node.props.id !== '')
  if (carriesStyling) return null
  return resolveContainerTag(node.moduleId, node.props)
}

/**
 * How a registered module spells itself as a WRITTEN TAG — a package component
 * names its specifier, the built-in design system names only the SYSTEM (the
 * server computes the path relative to the file being written), and an
 * intrinsic module is just its tag.
 *
 * `null` for an editor building block with no form in a user's repository,
 * which is a refusal rather than a guess. Shared by `wrap` and `group` so the
 * two cannot disagree about what a container is.
 */
function resolveContainerTag(
  containerModuleId: string,
  defaults: Record<string, unknown>,
): { name: string; importSpecifier?: string; designSystemImport?: true } | null {
  const mod = registry.get(containerModuleId)
  const sourceImport = mod?.sourceImport
  if (sourceImport) {
    return {
      name: sourceImport.name,
      ...(sourceImport.kind === 'package'
        ? { importSpecifier: sourceImport.specifier }
        : { designSystemImport: true as const }),
    }
  }
  const intrinsic = mod?.sourceIntrinsic?.({ ...(mod?.defaults ?? {}), ...defaults })
  return intrinsic ? { name: intrinsic.tag } : null
}
