/**
 * studioSourceRefusals — the two questions a caller asks BEFORE it touches a
 * studio-imported tree, and the sentences the answers carry.
 *
 * Split out of `studioSourceWrites.ts` at the module-size gate's prompting,
 * along the seam `store-13` already named in its own landmine list: "refusals
 * and their sentences" on one side, "the writers" on the other. The two are
 * genuinely different jobs — nothing here posts anything or plans a write; it
 * asks whether a container can take a gesture at all, presents the constraint
 * when it cannot, and hands the caller back the sentence the user was shown.
 *
 * Both are consumed through `StudioSourceWrites`, which spreads them in, so no
 * call site moved.
 */
import { describeStructuralRefusal, type NodeTree, type PageNode } from '@core/page-tree'
import { STRUCTURAL_REFUSAL_TITLE, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import type { SiteSliceHelpers } from './types'

export interface StudioSourceRefusals {
  /**
   * True when an insert into this container is refused — the caller must
   * stop. `retryWithParent`, when given, is called with whatever node
   * replaces `parentId` once a `detach`/`extract` remedy lands.
   */
  refuseInsertInto: (parentId: string, retryWithParent?: (newParentId: string) => void) => boolean
  /**
   * `mcp-21` / `store-13` — why a fragment of editor-built nodes cannot be
   * inserted into `parentId`, already presented to the user; `null` when it can.
   */
  refuseImportedNodesInto: (parentId: string, retryWithParent?: (newParentId: string) => void) => string | null
}

/** `readTree` is the active tree, read-only — see `createStudioSourceWrites` for why it is passed in. */
export function createStudioSourceRefusals(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
): StudioSourceRefusals {
  const { get, set } = helpers

  /**
   * `struct-01` — refuse a structural gesture that cannot be written back to
   * a studio-imported `.tsx`. Returns the sentence the user was shown, or
   * `null` when the gesture may proceed. A `null` tree (no site loaded) is not
   * this guard's business.
   */
  const refuseInsertIntoWithReason = (
    parentId: string,
    retryWithParent?: (newParentId: string) => void,
  ): string | null => {
    const tree = readTree()
    if (!tree) return null
    const plan = planSourceInsert(tree, parentId)
    if (plan.ok) return null
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
      nodeId: plan.nodeId,
      ...(retryWithParent ? { retry: (mapId: (nodeId: string) => string) => retryWithParent(mapId(parentId)) } : {}),
      getState: get,
      set,
    })
    return plan.constraint.explanation
  }

  /** `struct-01` — the boolean reading every caller but the HTML importer wants. */
  const refuseInsertInto = (parentId: string, retryWithParent?: (newParentId: string) => void): boolean =>
    refuseInsertIntoWithReason(parentId, retryWithParent) !== null

  /**
   * `mcp-21` - a fragment of ALREADY-MAPPED editor nodes on a studio-imported
   * tree. `insertImportedNodes` merges such a fragment straight into the page as
   * nanoid nodes and posts no source write at all, so the elements would show on
   * the canvas until the next parse and then silently not. A fragment of nodes
   * has no JSX to write (its module mapping is lossy and its ids are not source
   * locations), so this refuses it, whole.
   *
   * HTML itself is NOT refused any more (G-10): `writeHtmlToSource` converts the
   * markup to intrinsic JSX and writes it with its styles. Callers with HTML
   * ask that first; this guard only catches a caller that built nodes.
   */
  const refuseImportedNodesInto = (
    parentId: string,
    retryWithParent?: (newParentId: string) => void,
  ): string | null => {
    const containerRefusal = refuseInsertIntoWithReason(parentId, retryWithParent)
    if (containerRefusal) return containerRefusal
    const tree = readTree()
    if (!tree) return null
    const plan = planSourceInsert(tree, parentId)
    // `commit: null` is an ordinary CMS tree - merging a fragment is exactly
    // what that path is for, and nothing here applies to it.
    if (!plan.ok || !plan.commit) return null
    // Always `actions: []` - always the toast, never the dialog: the remedy is
    // a different gesture, not a button on this node.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.insert,
      describeStructuralRefusal({ refusal: { reason: 'insert', message: IMPORTED_NODES_ON_SOURCE_REFUSAL } }),
      { getState: get, set },
    )
    return IMPORTED_NODES_ON_SOURCE_REFUSAL
  }
  return { refuseInsertInto, refuseImportedNodesInto }
}

/**
 * The one sentence behind a refused fragment of editor nodes on a studio-imported
 * tree. A module constant rather than an inline string because both audiences
 * read it: the modal shows it inline, and the agent executor returns it as the
 * tool's error.
 */
export const IMPORTED_NODES_ON_SOURCE_REFUSAL =
  'A set of elements built in the editor has no JSX to write into your React files. Add the elements one at a time from the component picker.'
