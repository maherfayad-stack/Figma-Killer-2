/**
 * The structural gestures that, on a studio-imported tree, are a SOURCE WRITE
 * rather than a tree mutation: insert, duplicate and wrap.
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
 * The wrapper/element spelling comes from the MODULE REGISTRY
 * (`sourceImport` / `sourceIntrinsic`), never from a hardcoded design system,
 * so a project with its own component library writes its own components.
 */
import { registry } from '@core/module-engine'
import { describeStructuralRefusal, type NodeTree, type PageNode } from '@core/page-tree'
import { broadcastOptimisticInsert } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import {
  commitStudioDuplicate,
  commitStudioInsert,
  commitStudioWrap,
  guardAgainstConcurrentStructuralCommit,
} from '@site/studio/studioStructuralCommits'
import {
  STRUCTURAL_REFUSAL_TITLE,
  planSourceDuplicate,
  planSourceDuplicateTo,
  planSourceInsert,
  planSourceWrap,
  presentStructuralRefusal,
} from './structuralSourceEdits'
import { insertableJsxProps } from './insertablePropValues'
import type { SiteSliceHelpers } from './types'

export interface StudioSourceWrites {
  /**
   * True when an insert into this container is refused — the caller must
   * stop. `retryWithParent`, when given, is called with whatever node
   * replaces `parentId` once a `detach`/`extract` remedy lands — the caller's
   * own way to re-run ITS gesture (`insertComponentRef`, `insertImportedNodes`)
   * against the new parent, since neither of those goes through the
   * self-recursive `write*ToSource` retry shape below (they mutate the tree
   * directly rather than posting a source write).
   */
  refuseInsertInto: (parentId: string, retryWithParent?: (newParentId: string) => void) => boolean
  /** True when the caller must stop: the element was written to source, or the write was refused out loud. */
  writeInsertToSource: (
    moduleId: string,
    defaults: Record<string, unknown> | undefined,
    parentId: string,
    index?: number,
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

  /**
   * `struct-01` — refuse a structural gesture that cannot be written back to
   * a studio-imported `.tsx`. Returns true when the caller must stop.
   * A `null` tree (no site loaded) is not this guard's business.
   */
  const refuseInsertInto = (parentId: string, retryWithParent?: (newParentId: string) => void): boolean => {
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceInsert(tree, parentId)
    if (plan.ok) return false
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
      nodeId: plan.nodeId,
      retry: retryWithParent,
      getState: get,
      set,
    })
    return true
  }

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
  const writeInsertToSource = (moduleId: string, defaults: Record<string, unknown> | undefined, parentId: string, index?: number): boolean => {
    // `store-11` — refuse a second structural gesture while a prior one is
    // still being written+resynced; see `guardAgainstConcurrentStructuralCommit`.
    if (guardAgainstConcurrentStructuralCommit()) return true
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceInsert(tree, parentId, index)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
        nodeId: plan.nodeId,
        // The refused node here is the CONTAINER (`parentId`) — re-issue the
        // same insert against whatever replaces it once detach/extract lands.
        retry: (newParentId) => writeInsertToSource(moduleId, defaults, newParentId, index),
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
      // `live-07` — same-tick ghost paint for a live (bridge) frame: there is
      // no real node id yet (the element doesn't exist until the codemod
      // writes it), so a throwaway placeholder id stands in purely as the
      // ghost's own `data-node-id`. Safe because `BridgeFrameAdapter.optimistic
      // .insert` never looks the id up, and `runtime.ts`'s ghost sweep removes
      // it wholesale on the next Fast Refresh. `'div'` is the least-disruptive
      // generic placeholder tag — a design-system component's real root tag
      // is unknowable without executing it.
      broadcastOptimisticInsert(`optimistic:${crypto.randomUUID()}`, plan.commit.parentNodeId, index ?? Number.MAX_SAFE_INTEGER, 'div')
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
      })
      return true
    }

    // Still possibly a real element: `base.container` is a `<div>`/`<span>`,
    // `base.text` a `<p>` wrapping text. `insertJsxElement` writes those by
    // omitting `importSpecifier`. See `sourceIntrinsic` on `ModuleDefinition`.
    const intrinsic = mod?.sourceIntrinsic?.(props)
    if (intrinsic) {
      // `live-07` — same as above, but an honest tag match: `intrinsic.tag`
      // is exactly what the codemod is about to write.
      broadcastOptimisticInsert(
        `optimistic:${crypto.randomUUID()}`,
        plan.commit.parentNodeId,
        index ?? Number.MAX_SAFE_INTEGER,
        intrinsic.tag,
        intrinsic.text,
      )
      void commitStudioInsert({
        ...plan.commit,
        name: intrinsic.tag,
        props: {},
        ...(intrinsic.text === undefined ? {} : { children: intrinsic.text }),
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
    // `store-11` — this is the exact gesture the race was found on: a rapid
    // double-click/keypress on Duplicate before the first click's resync
    // lands used to plan a SECOND duplicate against the still-unshifted
    // original, writing two real copies for one gesture and pushing two
    // "Written to your project source" toasts. See
    // `guardAgainstConcurrentStructuralCommit`'s doc for the full mechanism.
    // K2's Alt+drag rides the identical guard, and needs it for the identical
    // reason: two Alt-drops in quick succession are two independent writes
    // planned against one unshifted original.
    if (guardAgainstConcurrentStructuralCommit()) return true
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
      const { nodeId, ...where } = plan.commit
      void commitStudioDuplicate([nodeId], where)
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
    void commitStudioDuplicate(plan.commit)
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
    // `store-11` — same re-entrancy guard as `writeDuplicateToSource`.
    if (guardAgainstConcurrentStructuralCommit()) return true
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

    const mod = registry.get(containerModuleId)
    const props = { ...(mod?.defaults ?? {}), ...defaults }
    const sourceImport = mod?.sourceImport
    if (sourceImport) {
      void commitStudioWrap({
        nodeId: plan.commit,
        name: sourceImport.name,
        ...(sourceImport.kind === 'package'
          ? { importSpecifier: sourceImport.specifier }
          : { designSystemImport: true as const }),
      })
      return true
    }
    const intrinsic = mod?.sourceIntrinsic?.(props)
    if (intrinsic) {
      void commitStudioWrap({ nodeId: plan.commit, name: intrinsic.tag })
      return true
    }
    // Always `actions: []` — always the toast, never the dialog.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.wrap,
      describeStructuralRefusal({
        refusal: {
          reason: 'wrap',
          message: `"${mod?.name ?? containerModuleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write around this element. Wrap it in a container instead.`,
        },
      }),
      { getState: get, set },
    )
    return true
  }

  return { refuseInsertInto, writeInsertToSource, writeDuplicateToSource, writeWrapToSource }
}
