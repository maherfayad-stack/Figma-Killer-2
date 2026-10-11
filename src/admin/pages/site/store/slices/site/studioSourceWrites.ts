/**
 * The structural gestures that, on a studio-imported tree, are a SOURCE WRITE
 * rather than a tree mutation: insert, duplicate, wrap, (K3) group and
 * ungroup. Paste (`store-13`) is the same shape and lives next door, in
 * `studioPasteWrites.ts`.
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
import {
  decodeSourceNodeId,
  describeStructuralRefusal,
  isSiblingRun,
  planListRowCopy,
  planListRowCopyTo,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { localComponentJsxName, type LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { relativeImportSpecifier } from '@site/property-controls/relativeImportSpecifier'
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
  type SourceInsertCommit,
} from './structuralSourceEdits'
import { moduleInsertProps, moduleSourceElement } from './moduleSourceElement'
import { createStudioSourceRefusals, type StudioSourceRefusals } from './studioSourceRefusals'
import {
  previewOptimisticDuplicate,
  previewOptimisticGroup,
  previewOptimisticInsert,
  previewOptimisticWrap,
} from './structuralOptimism'
import { writeListRowPlan } from './listRowSourceWrites'
import type { FrameRequest } from './frameRequest'
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
    frame?: FrameRequest,
  ) => boolean
  /**
   * Insert a component declared in the user's own project (the Assets panel's
   * "Project components"). Same contract as `writeInsertToSource`: true when the
   * caller must stop (written, parked, or refused out loud), false on an ordinary
   * CMS tree.
   */
  writeInsertProjectComponentToSource: (
    component: LocalComponentSpec,
    parentId: string,
    index?: number,
    style?: Record<string, string>,
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
  /**
   * The questions every source insert asks before it writes, shared by the
   * registry-module insert and the project-component insert so the two cannot
   * drift: defer behind an in-flight structural commit, find the tree, ask
   * `planSourceInsert`. `'stop'` — parked, or refused out loud (the caller
   * returns true). `'cms'` — an ordinary CMS tree (the caller returns false and
   * takes the in-memory path).
   */
  const planInsertToSource = (
    parentId: string,
    index: number | undefined,
    again: (parentId: string) => void,
  ): { kind: 'commit'; commit: SourceInsertCommit } | { kind: 'stop' } | { kind: 'cms' } => {
    // `store-14` — a second structural gesture fired while a prior one is
    // still being written+resynced runs NEXT rather than being refused. It is
    // parked as a thunk and re-planned against the tree that commit's resync
    // leaves behind; see `structuralCommitQueue.ts`.
    if (deferWhileStructuralCommitInFlight((relocate) => again(relocate(parentId)), [parentId])) {
      return { kind: 'stop' }
    }
    const tree = readTree()
    if (!tree) return { kind: 'cms' }
    const plan = planSourceInsert(tree, parentId, index)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
        nodeId: plan.nodeId,
        // The refused node here is the CONTAINER (`parentId`) — re-issue the
        // same insert against whatever replaces it once detach/extract lands.
        retry: (mapId) => again(mapId(parentId)),
        getState: get,
        set,
      })
      return { kind: 'stop' }
    }
    if (!plan.commit) return { kind: 'cms' } // an ordinary CMS tree — nothing to write
    return { kind: 'commit', commit: plan.commit }
  }

  /**
   * A component declared in the user's OWN project (`components/Card.tsx`) —
   * the Assets panel's "Project components". Not a registry module: it has no
   * canvas definition to render, so there is no optimistic local preview, only
   * the bridge ghost; the write's resync brings in the real parsed element.
   *
   * The import specifier is computed HERE, relative to the file the element is
   * written into — the file is the one `parentNodeId` decodes to — because the
   * catalog names the component file workspace-relative and the codemod writes
   * whatever specifier it is handed. `importStyle: 'default'` for a default
   * export, which is how most project components are declared.
   */
  const writeInsertProjectComponentToSource = (
    component: LocalComponentSpec,
    parentId: string,
    index?: number,
    style?: Record<string, string>,
  ): boolean => {
    const planned = planInsertToSource(parentId, index, (relocated) => {
      writeInsertProjectComponentToSource(component, relocated, index, style)
    })
    if (planned.kind === 'stop') return true
    if (planned.kind === 'cms') return false
    const { commit } = planned
    const targetFile = decodeSourceNodeId(commit.parentNodeId)?.rel
    if (!targetFile) return false
    broadcastOptimisticInsert(
      `optimistic:${crypto.randomUUID()}`,
      commit.previewParentId ?? commit.parentNodeId,
      index ?? Number.MAX_SAFE_INTEGER,
      'div',
      undefined,
    )
    void commitStudioInsert({
      ...commit,
      name: localComponentJsxName(component),
      importSpecifier: relativeImportSpecifier(targetFile, component.file),
      ...(component.isDefaultExport ? { importStyle: 'default' as const } : {}),
      props: style && Object.keys(style).length > 0 ? { style: { ...style } } : {},
    })
    return true
  }

  const writeInsertToSource = (
    moduleId: string,
    defaults: Record<string, unknown> | undefined,
    parentId: string,
    index?: number,
    inlineStyles?: Record<string, string>,
  ): boolean => {
    const plan = planInsertToSource(parentId, index, (relocated) => {
      writeInsertToSource(moduleId, defaults, relocated, index, inlineStyles)
    })
    if (plan.kind === 'stop') return true
    if (plan.kind === 'cms') return false

    const element = moduleSourceElement(moduleId, defaults, inlineStyles)
    if (!element) {
      // An editor construct with no spelling in a user's repo; the picker
      // hides those in studio mode, so this is the programmatic path. Always
      // `actions: []` — always the toast, never the dialog.
      presentStructuralRefusal(
        STRUCTURAL_REFUSAL_TITLE.insert,
        describeStructuralRefusal({
          refusal: {
            reason: 'insert',
            message: `"${registry.get(moduleId)?.name ?? moduleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write to the file. Add a design-system component instead.`,
          },
        }),
        { getState: get, set },
      )
      return true
    }

    // `live-07`/`perf-10` — same-tick paint for BOTH frame kinds, sharing ONE
    // placeholder id: a throwaway `optimistic:` id stands in as the bridge
    // ghost's own `data-node-id` (safe because
    // `BridgeFrameAdapter.optimistic.insert` never looks it up, and
    // `runtime.ts`'s ghost sweep removes it wholesale on the next Fast
    // Refresh) AND as the temporary node's real id in the local tree, which is
    // what makes a PORTAL frame paint too — it renders from that tree, not
    // from a DOM ghost. An intrinsic element's ghost is an honest tag match;
    // a component's real root tag is unknowable without executing it, so its
    // bridge ghost is the least-disruptive generic `div` while the local
    // preview renders the registered module with its own defaults.
    const ghostId = `optimistic:${crypto.randomUUID()}`
    broadcastOptimisticInsert(
      ghostId,
      plan.commit.previewParentId ?? plan.commit.parentNodeId,
      index ?? Number.MAX_SAFE_INTEGER,
      element.intrinsic ? element.name : 'div',
      element.intrinsic ? element.children : undefined,
    )
    const optimistic =
      previewOptimisticInsert(
        helpers,
        moduleId,
        moduleInsertProps(moduleId, defaults),
        plan.commit.previewParentId ?? plan.commit.parentNodeId,
        index,
        ghostId,
        element.intrinsic ? inlineStyles : undefined,
      ) ?? undefined
    void commitStudioInsert({
      ...plan.commit,
      name: element.name,
      ...(element.importSpecifier === undefined ? {} : { importSpecifier: element.importSpecifier }),
      ...(element.designSystemImport === undefined ? {} : { designSystemImport: element.designSystemImport }),
      props: element.props,
      ...(element.children === undefined ? {} : { children: element.children }),
      ...(optimistic ? { optimistic } : {}),
    })
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

    const retryWithMap = (mapId: (nodeId: string) => string): void => {
      void writeDuplicateToSource(nodeIds.map(mapId), destination ? { ...destination, parentId: mapId(destination.parentId) } : undefined)
    }

    // OD-8 — `.map` rows are copied in their array: after themselves (⌘D),
    // or where an Alt-drag drops them inside their own list.
    const rowNodes = nodeIds.map((id) => tree.nodes[id]).filter((node): node is PageNode => node !== undefined)
    const rows = destination
      ? planListRowCopyTo(tree, rowNodes, destination.parentId, destination.index)
      : planListRowCopy(rowNodes)
    if (rows) {
      writeListRowPlan(rows, STRUCTURAL_REFUSAL_TITLE.duplicate, { get, set, retry: retryWithMap })
      return true
    }

    // K2 — Alt+drag: the copy lands INSIDE a container the user pointed at,
    // which is a second question (`planSourceDuplicateTo`) rather than a flag
    // on the first. See that function for why the anchor is an insert's, not
    // a move's.
    if (destination) {
      const plan = planSourceDuplicateTo(tree, nodeIds, destination.parentId, destination.index)
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.duplicate, plan.constraint, {
          nodeId: plan.nodeId,
          retry: retryWithMap,
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
        retry: retryWithMap,
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
    // ERR-7 — one container around SEVERAL elements is a group: one wrapper
    // around their run, one write, one undo. It used to refuse `multi-select`.
    if (nodeIds.length > 1) return writeGroupToSource(nodeIds, containerModuleId, defaults)
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
        retry: (mapId) => { void writeWrapToSource(nodeIds.map(mapId), containerModuleId, defaults) },
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
    frame?: FrameRequest,
  ): boolean => {
    if (nodeIds.length === 0) return false
    // `store-14` — same queue as `writeDuplicateToSource`: a held Cmd+G must
    // not plan a second group against the still-unshifted original, but it
    // must not be thrown away either.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writeGroupToSource(nodeIds.map(relocate), containerModuleId, defaults, frame)
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
        retry: (mapId) => { void writeGroupToSource(nodeIds.map(mapId), containerModuleId, defaults, frame) },
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
    if (frame) {
      // PA-6 — a frame is ALWAYS a `group` (even around one element), has no
      // optimistic preview (a bare wrapper would flash before its style
      // lands), and its patches follow the run in source order.
      void commitStudioGroup({
        nodeIds: plan.commit,
        ...container,
        frame: {
          wrapperStyle: frame.wrapperStyle,
          memberStyles: plan.commit.map((id) => frame.memberStyles[id] ?? {}),
        },
      })
    } else if (only !== undefined) {
      const optimistic = previewOptimisticWrap(helpers, only, containerModuleId, resolvedDefaults) ?? undefined
      void commitStudioWrap({ nodeId: only, ...container, ...(optimistic ? { optimistic } : {}) })
    } else {
      // G-7 - members that are not one run of siblings are gathered by the
      // write (`gatherGroupRun.ts`); a local wrap would draw a container around
      // a span the file does not have, so the board waits for the re-read.
      const optimistic = isSiblingRun(tree, plan.commit)
        ? (previewOptimisticGroup(helpers, plan.commit, containerModuleId, resolvedDefaults) ?? undefined)
        : undefined
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
        retry: (mapId) => { void writeUngroupToSource(mapId(nodeId)) },
        getState: get,
        set,
      })
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write
    void commitStudioUngroup(plan.commit)
    return true
  }

  return {
    ...refusals,
    writeInsertToSource,
    writeInsertProjectComponentToSource,
    writeDuplicateToSource,
    writeWrapToSource,
    writeGroupToSource,
    writeUngroupToSource,
  }
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
