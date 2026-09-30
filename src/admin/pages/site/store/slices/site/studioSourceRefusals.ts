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
   * `mcp-21` / `store-13` — why a fragment of imported HTML cannot be inserted
   * into `parentId`, already presented to the user; `null` when it can.
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
   * `mcp-21`'s open defect — a fragment of imported HTML on a studio-imported
   * tree.
   *
   * `insertImportedNodes` merged the fragment straight into the page as nanoid
   * nodes and posted no source write at all, so the elements showed on the
   * canvas until the next parse and then silently did not. Reachable from the
   * paste-HTML modal and, more seriously, from an external MCP client with
   * `ai.tools.write` calling `site_insert_html` / `site_replace_node_html`.
   *
   * This refuses it. Unlike `insert`/`duplicate`/`wrap`/`paste`, an HTML
   * fragment has no source write to route to instead, and the reason is
   * structural rather than a gap to be closed later:
   *
   *  1. **Most of it has no spelling.** The importer's own rule table maps HTML
   *     onto ~15 base modules, and exactly two of them — `base.container` and
   *     `base.text` — can say what they are in a user's repo
   *     (`ModuleDefinition.sourceIntrinsic`). A link, a button, an image, every
   *     form control, `<studio-loop>` and `<studio-outlet>` have no JSX form
   *     Studio may write. Writing the part that can be written and dropping the
   *     rest is the half-applied patch this store refuses everywhere else.
   *  2. **The CSS has a different target.** The `<style>` block that comes with
   *     the markup belongs in a stylesheet, not in the `.tsx`, so one call
   *     would have to land two writes in two files or leave the structure
   *     unstyled.
   *  3. **The tool's own answer cannot be honoured.** `site_insert_html`
   *     returns the ids it created so the caller can address them; a source
   *     write's ids are the `line:col`s the codemod produces and do not exist
   *     until the resync, which is after the tool has returned.
   *
   * So: the whole fragment, or none of it. The refusal names the two paths that
   * do write real code.
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
    // `commit: null` is an ordinary CMS tree — imported HTML is exactly what
    // that path is for, and nothing here applies to it.
    if (!plan.ok || !plan.commit) return null
    // Always `actions: []` — always the toast, never the dialog: the remedy is
    // a different tool, not a button on this node.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.insert,
      describeStructuralRefusal({ refusal: { reason: 'insert', message: HTML_IMPORT_ON_SOURCE_REFUSAL } }),
      { getState: get, set },
    )
    return HTML_IMPORT_ON_SOURCE_REFUSAL
  }
  return { refuseInsertInto, refuseImportedNodesInto }
}

/**
 * The one sentence behind every refused HTML import on a studio-imported tree.
 * A module constant rather than an inline string because both audiences read
 * it: the paste-HTML modal shows it inline, and the agent executor returns it
 * as the tool's error. See `refuseImportedNodesInto` for the three reasons.
 */
export const HTML_IMPORT_ON_SOURCE_REFUSAL =
  'Every element on this board is written back into your project’s React files, and a block of HTML has no single honest form to write there: most of its tags (links, buttons, images, form controls) have no component in this project, and its CSS belongs in a stylesheet rather than in the markup. Nothing was added. Add elements one at a time from the component picker, which writes real JSX.'
