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
import { commitStudioDuplicate, commitStudioInsert, commitStudioWrap } from '@site/studio/studioStructuralCommits'
import {
  STRUCTURAL_REFUSAL_TITLE,
  planSourceDuplicate,
  planSourceInsert,
  planSourceWrap,
  toastStructuralRefusal,
} from './structuralSourceEdits'
import { insertableJsxProps } from './insertablePropValues'
import type { SiteSliceHelpers } from './types'

export interface StudioSourceWrites {
  /** True when an insert into this container is refused — the caller must stop. */
  refuseInsertInto: (parentId: string) => boolean
  /** True when the caller must stop: the element was written to source, or the write was refused out loud. */
  writeInsertToSource: (
    moduleId: string,
    defaults: Record<string, unknown> | undefined,
    parentId: string,
    index?: number,
  ) => boolean
  writeDuplicateToSource: (nodeIds: readonly string[]) => boolean
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
  const { get } = helpers

  /**
   * `struct-01` — refuse a structural gesture that cannot be written back to
   * a studio-imported `.tsx`. Returns true when the caller must stop.
   * A `null` tree (no site loaded) is not this guard's business.
   */
  const refuseInsertInto = (parentId: string): boolean => {
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceInsert(tree, parentId)
    if (plan.ok) return false
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, get)
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
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceInsert(tree, parentId, index)
    if (!plan.ok) {
      toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, get)
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write

    const mod = registry.get(moduleId)
    const props = { ...(mod?.defaults ?? {}), ...(defaults ?? {}) }
    const sourceImport = mod?.sourceImport

    if (sourceImport) {
      void commitStudioInsert({
        ...plan.commit,
        name: sourceImport.name,
        importSpecifier: sourceImport.specifier,
        props: insertableJsxProps(props),
      })
      return true
    }

    // Still possibly a real element: `base.container` is a `<div>`/`<span>`,
    // `base.text` a `<p>` wrapping text. `insertJsxElement` writes those by
    // omitting `importSpecifier`. See `sourceIntrinsic` on `ModuleDefinition`.
    const intrinsic = mod?.sourceIntrinsic?.(props)
    if (intrinsic) {
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
    toastStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.insert,
      describeStructuralRefusal({
        refusal: {
          reason: 'insert',
          message: `"${mod?.name ?? moduleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write to the file. Add a design-system component instead.`,
        },
      }),
      get,
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
  const writeDuplicateToSource = (nodeIds: readonly string[]): boolean => {
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceDuplicate(tree, nodeIds)
    if (!plan.ok) {
      toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.duplicate, plan.constraint, get)
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
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceWrap(tree, nodeIds)
    if (!plan.ok) {
      toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.wrap, plan.constraint, get)
      return true
    }
    if (!plan.commit) return false // an ordinary CMS tree — nothing to write

    const mod = registry.get(containerModuleId)
    const props = { ...(mod?.defaults ?? {}), ...defaults }
    const sourceImport = mod?.sourceImport
    if (sourceImport) {
      void commitStudioWrap({ nodeId: plan.commit, name: sourceImport.name, importSpecifier: sourceImport.specifier })
      return true
    }
    const intrinsic = mod?.sourceIntrinsic?.(props)
    if (intrinsic) {
      void commitStudioWrap({ nodeId: plan.commit, name: intrinsic.tag })
      return true
    }
    toastStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.wrap,
      describeStructuralRefusal({
        refusal: {
          reason: 'wrap',
          message: `"${mod?.name ?? containerModuleId}" is an editor building block, not a component in your project's code, so there is nothing Studio could write around this element. Wrap it in a container instead.`,
        },
      }),
      get,
    )
    return true
  }

  return { refuseInsertInto, writeInsertToSource, writeDuplicateToSource, writeWrapToSource }
}
