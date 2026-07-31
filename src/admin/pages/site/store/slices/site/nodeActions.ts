/**
 * Node mutation actions for the active document tree.
 *
 * The 11 named tree-mutation actions (`insertNode`, `deleteNode`,
 * `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`,
 * `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`,
 * `duplicateNode`, `wrapNode`) all delegate to `mutateActiveTree(fn)` and
 * MUST NOT contain their own `kind === 'visualComponent'` branch — that
 * routing is the sole job of `mutateActiveTree`. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 *
 * `struct-01` — the STRUCTURAL actions (`insertNode`, `deleteNode(s)`,
 * `moveNode(s)`, `duplicateNode(s)`, `wrapNode(s)`) additionally consult
 * `structuralSourceEdits.ts` before mutating, so that on a studio-imported
 * tree they either write the user's `.tsx` or refuse with a readable reason.
 * They never do neither, which is what they used to do.
 */

import { registry } from '@core/module-engine'

import {
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNodes,
  wrapNode,
  wrapNodes,
  reindexNodeParents,
  isPropPatchWritableToSource,
  isPropWritableToSource,
  isStylePatchWritableToSource,
} from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import { subtreeHasOutlet, treeHasOutlet } from '@core/templates'
import { wouldCreateCycle, syncSlotInstances, applySlotSyncResult } from '@core/visualComponents'
import { pushToast } from '@ui/components/Toast'
import { commitStudioDelete, commitStudioMove } from '@site/studio/studioSaveRequests'
import { resolveActiveTreeTarget } from './helpers'
import { createDeleteNodesAction } from './deleteNodesAction'
import { duplicateNodeWithScopedClasses } from './duplicateWithScopedClasses'
import {
  STRUCTURAL_REFUSAL_TITLE,
  planSourceCopy,
  planSourceDelete,
  planSourceInsert,
  planSourceMove,
  toastStructuralRefusal,
} from './structuralSourceEdits'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { indexStyleRulesByName, linkImportedClassNames, mergeImportedStyleRules } from './importLinking'
import type { SiteSlice, SiteSliceHelpers } from './types'

type NodeActions = Pick<
  SiteSlice,
  | 'insertNode'
  | 'insertComponentRef'
  | 'insertImportedNodes'
  | 'deleteNode'
  | 'deleteNodes'
  | 'updateNodeProps'
  | 'updateInstanceCallSiteProp'
  | 'setNodeInlineStyles'
  | 'removeNodeInlineStyleProperty'
  | 'clearNodeInlineStyles'
  | 'setBreakpointOverride'
  | 'clearBreakpointOverride'
  | 'renameNode'
  | 'toggleNodeLocked'
  | 'toggleNodeHidden'
  | 'moveNode'
  | 'moveNodes'
  | 'duplicateNode'
  | 'duplicateNodes'
  | 'wrapNode'
  | 'wrapNodes'
  | 'setNodeDynamicBinding'
  | 'clearNodeDynamicBinding'
>

function recordPatchChanges(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).some(([key, value]) => !Object.is(current[key], value))
}

/**
 * Surface a blocked one-outlet-per-document mutation to the user. The store is
 * the chokepoint every mutation path runs through (picker, drag-drop, context
 * menus, keyboard shortcuts, spotlight, agent), so the feedback lives here too
 * — the toast bus is explicitly designed for store-side producers.
 */
function toastOutletBlocked(body: string): void {
  pushToast({
    kind: 'warning',
    title: 'Only one content outlet',
    body,
    location: 'site-editor',
  })
}

/**
 * Build the history-coalescing options for a single-field patch, or `undefined`
 * for multi-field patches (which always get their own discrete undo entry).
 *
 * Per-keystroke text/number controls patch exactly one prop per change, so a
 * stable `<scope>:<nodeId>:<prop>` key lets `pushHistorySnapshot` fold a whole
 * typing burst into one undo step instead of cloning the site per character.
 */
function coalesceKeyForPatch(
  scope: string,
  nodeId: string,
  patch: Record<string, unknown>,
): { coalesceKey: string } | undefined {
  const keys = Object.keys(patch)
  if (keys.length !== 1) return undefined
  return { coalesceKey: `${scope}:${nodeId}:${keys[0]}` }
}

export function createNodeActions(helpers: SiteSliceHelpers): NodeActions {
  const { get, set, mutateActiveTree, mutateActiveTreeAndSite, mutateTreesForNodeIds } = helpers

  /**
   * The active tree, read-only, for the structural gate below. Every guard
   * has to answer BEFORE the mutation runs — a refusal that arrives from
   * inside a Mutative recipe has already changed the document it is refusing.
   */
  const readTree = (): NodeTree<PageNode> | null => resolveActiveTreeTarget(get())?.tree ?? null

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
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.refusal)
    return true
  }

  const refuseCopy = (kind: 'duplicate' | 'wrap', nodeIds: readonly string[]): boolean => {
    const tree = readTree()
    if (!tree) return false
    const plan = planSourceCopy(tree, kind, nodeIds)
    if (plan.ok) return false
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE[kind], plan.refusal)
    return true
  }

  const actions: NodeActions = {
    insertNode: (moduleId, defaults, parentId, index) => {
      if (refuseInsertInto(parentId)) return ''
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      let inserted = false
      let blockedByOutlet = false
      mutateActiveTree((tree) => {
        // Structural invariant: a document tree holds AT MOST ONE base.outlet.
        // Matched content (a page or the current entry body) flows into a single
        // outlet — both the publisher's `composeTemplateChain` and the canvas's
        // read-only wrapper fill only the first, leaving any extra outlet to
        // render as a dead, empty placeholder. This is the mutation chokepoint
        // every insert path runs through (picker, drag-drop, programmatic), so
        // blocking the second outlet here keeps the invariant no matter the
        // caller. `duplicateNode(s)` and `pasteNode` carry the same guard.
        if (moduleId === 'base.outlet' && treeHasOutlet(tree)) {
          blockedByOutlet = true
          return false
        }
        insertNode(tree, newNode, parentId, index)
        inserted = true
        return true
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'This document already has a content outlet — matched content can flow into just one.',
        )
      }
      return inserted ? newNode.id : ''
    },

    insertImportedNodes: (parentId, fragment, opts) => {
      if (fragment.rootIds.length === 0) return []
      if (refuseInsertInto(parentId)) return []
      const insertedRootIds: string[] = []
      mutateActiveTreeAndSite((tree, site) => {
        const parent = tree.nodes[parentId]
        if (!parent) return false
        const isRoot = tree.rootNodeId === parentId
        const definition = registry.get(parent.moduleId)
        const acceptsChildren = isRoot || definition?.canHaveChildren === true
        if (!acceptsChildren) return false

        // The HTML importer stamps class *names* onto each fragment node's
        // classIds (`walkAndMap` copies el.classList verbatim). The engine
        // keys classes by id and resolves styles by id, so link every imported
        // name to a real registry class — reusing an existing same-named class
        // or auto-creating a bare one — as the nodes enter the live tree.
        // Without this step the names never resolve and styles never apply.
        //
        // Nodes already carry fresh nanoid IDs from createNode — no collision
        // risk on the node map.
        const classesByName = indexStyleRulesByName(site.styleRules)

        // Commit rules parsed from <style> blocks BEFORE linking class names so
        // a node's `class="foo"` token binds to the just-added `.foo {}` rule
        // (rather than auto-creating a bare class). These show in the Selectors
        // panel like any other rule.
        if (opts?.styleRules?.length) {
          mergeImportedStyleRules(opts.styleRules, site.styleRules, classesByName)
        }
        // Register any reusable conditions (custom @media / @container /
        // @supports) the <style> rules reference via contextStyles keys.
        if (opts?.conditions?.length) {
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of opts.conditions) {
            if (existing.has(def.id)) continue
            existing.add(def.id)
            site.conditions.push(def)
          }
        }

        for (const [id, node] of Object.entries(fragment.nodes)) {
          // `node.inlineStyles` (imported inline `style="…"`) rides along on
          // the `...node` spread — it is a first-class node field.
          tree.nodes[id] = {
            ...node,
            classIds: linkImportedClassNames(node.classIds, site.styleRules, classesByName),
          }
        }

        // Wire the imported root nodes as children of the target parent.
        const insertAt = opts?.index ?? parent.children.length
        parent.children.splice(insertAt, 0, ...fragment.rootIds)
        insertedRootIds.push(...fragment.rootIds)
        // The fragment was bulk-merged into tree.nodes (not via insertNode), so
        // derive the parentId index across the active tree to keep the inserted
        // subtree's pointers consistent. Deliberately O(active-tree), not a
        // targeted O(fragment) update: import is an infrequent path, and a full
        // reindex is the simplest bulletproof way to stay consistent.
        reindexNodeParents(tree.nodes)
        return true
      })
      return insertedRootIds
    },

    insertComponentRef: (parentId, componentId, index) => {
      if (!componentId) return null
      if (refuseInsertInto(parentId)) return null

      const { activeDocument, site } = get()

      // In VC mode, guard against cyclic component references before insertion.
      if (activeDocument?.kind === 'visualComponent' && site) {
        if (wouldCreateCycle(site.visualComponents, activeDocument.vcId, componentId)) {
          console.warn('[component-system] cycle prevented by recursion guard')
          return null
        }
      }

      // Resolve the referenced VC up-front (read-only) so its slot-instance
      // children can be materialized in the SAME mutation as the ref insertion.
      const vc = site?.visualComponents.find((v) => v.id === componentId)

      // Build the ref node with the module's registry defaults plus the
      // ref-specific props. `index` forwards to insertNode so callers using
      // resolveInsertLocation can drop the ref at a precise sibling position.
      const mod = registry.get('base.visual-component-ref')
      const newNode = createNode('base.visual-component-ref', {
        ...(mod?.defaults ?? {}),
        componentId,
        propOverrides: {},
      })

      // Insert the VC ref AND materialize its slot-instance children inside ONE
      // mutateActiveTree recipe, so both writes land in a single patch set →
      // a single undo entry. (Splitting them — ref via insertNode, slots via a
      // separate set() outside history — meant Cmd+Z reverted only the ref and
      // left the slot-instance nodes orphaned in the persisted node map forever.)
      const inserted = mutateActiveTree((tree) => {
        insertNode(tree, newNode, parentId, index)
        if (vc) {
          const vcRefNode = tree.nodes[newNode.id]
          if (vcRefNode) {
            const syncResult = syncSlotInstances(vcRefNode, vc, tree.nodes)
            applySlotSyncResult(tree.nodes, syncResult, newNode.id)
          }
        }
        return true
      })

      return inserted ? newNode.id : null
    },

    deleteNode: (nodeId) => {
      // `struct-01` — refuse BEFORE mutating, so a delete the source cannot
      // take never removes the element from the canvas either.
      const plan = planSourceDelete([readTree()?.nodes[nodeId]])
      if (!plan.ok) {
        toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, plan.refusal)
        return
      }
      const deleted = mutateActiveTree((tree) => {
        if (!tree.nodes[nodeId]) return false
        deleteNode(tree, nodeId)
        return true
      })
      if (deleted && plan.commit) void commitStudioDelete(plan.commit)
      // Drop the deleted node (and any descendants swept with it) from the
      // canvas selection so no phantom selection ring survives. Pruning by
      // tree-membership also clears `selectedNodeIds`, not just the anchor.
      if (deleted) {
        set((state) => { pruneCanvasSelectionDraft(state) })
      }
    },

    updateNodeProps: (nodeId, patch) => {
      mutateActiveTree(
        (tree) => {
          const node = tree.nodes[nodeId]
          if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
          // On a studio-imported node, writability is PER-PROP: a prop backed by
          // a literal attribute at this element is editable even when the node's
          // structure is code-controlled (a `.map` made it, a ternary chose it),
          // while a prop backed by an expression is not, because writing there
          // would replace the binding with a baked literal. See
          // `isPropPatchWritableToSource` for why this is not keyed on
          // `lockReason` — that describes structure, not values.
          //
          // Silent no-op: this action is also called programmatically (agent,
          // plugins), so a toast here would be noise, not user feedback. The
          // panel is what tells the user, by not offering the control.
          if (!isPropPatchWritableToSource(node, patch)) return false
          if (!recordPatchChanges(node.props, patch)) return false
          updateNodeProps(tree, nodeId, patch)
          return true
        },
        coalesceKeyForPatch('props', nodeId, patch),
      )
    },

    updateInstanceCallSiteProp: (nodeId, propName, value) => {
      mutateActiveTree(
        (tree) => {
          const node = tree.nodes[nodeId]
          if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
          // instance-ui-01 — call-site props live nested at
          // `props.callSiteProps` (parser-05's deliberate non-flat shape),
          // so `updateNodeProps`'s own patch-level `isPropPatchWritableToSource`
          // check (keyed on the literal patch KEY, "callSiteProps") can't see
          // a per-field lock keyed `callSiteProps:<name>` — this action checks
          // the SPECIFIC field being changed instead, same rule, right key.
          const codeKey = `callSiteProps:${propName}`
          if (!isPropWritableToSource(node, codeKey)) return false
          const current = (node.props as { callSiteProps?: Record<string, unknown> } | undefined)?.callSiteProps ?? {}
          if (Object.is(current[propName], value)) return false
          const nextCallSiteProps = { ...current, [propName]: value }
          updateNodeProps(tree, nodeId, { callSiteProps: nextCallSiteProps })
          return true
        },
        // Finer-grained than `coalesceKeyForPatch('props', …)` would give a
        // whole-object patch (that helper only coalesces single-KEY patches,
        // and the key here is always the literal string "callSiteProps") —
        // this keys on the actual field being edited, so a burst of
        // keystrokes on ONE call-site prop is one undo entry, and editing a
        // DIFFERENT call-site prop right after doesn't fold into it.
        { coalesceKey: `callSiteProps:${nodeId}:${propName}` },
      )
    },

    setNodeInlineStyles: (nodeId, patch) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        // Same per-property rule as `updateNodeProps` above — a `style={{}}`
        // entry authored as a literal is writable; one resolved from an
        // expression (`width: `${pct}%``) is not.
        if (!isStylePatchWritableToSource(node, patch)) return false
        const next: Record<string, unknown> = { ...(node.inlineStyles ?? {}) }
        let changed = false
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined || value === '') {
            if (key in next) {
              delete next[key]
              changed = true
            }
          } else if (!Object.is(next[key], value)) {
            next[key] = value
            changed = true
          }
        }
        if (!changed) return false
        // Drop the field entirely when the bag is empty so nodes without inline
        // styles stay lean (and the publisher emits no `style` attribute).
        if (Object.keys(next).length > 0) node.inlineStyles = next
        else delete node.inlineStyles
        return true
      })
    },

    removeNodeInlineStyleProperty: (nodeId, propKey) => {
      actions.setNodeInlineStyles(nodeId, { [propKey]: null })
    },

    clearNodeInlineStyles: (nodeId) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.inlineStyles) return false
        delete node.inlineStyles
        return true
      })
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutateActiveTree(
        (tree) => {
          const node = tree.nodes[nodeId]
          if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
          if (!recordPatchChanges(node.breakpointOverrides[breakpointId] ?? {}, patch)) {
            return false
          }
          setBreakpointOverride(tree, nodeId, breakpointId, patch)
          return true
        },
        coalesceKeyForPatch(`bp:${breakpointId}`, nodeId, patch),
      )
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.breakpointOverrides[breakpointId]) return false
        clearBreakpointOverride(tree, nodeId, breakpointId)
        return true
      })
    },

    renameNode: (nodeId, label) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        const nextLabel = label.trim() || undefined
        if (node.label === nextLabel) return false
        renameNode(tree, nodeId, label)
        return true
      })
    },

    toggleNodeLocked: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeLocked(tree, nodeId)
        return true
      })
    },

    toggleNodeHidden: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeHidden(tree, nodeId)
        return true
      })
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      actions.moveNodes([nodeId], newParentId, newIndex)
    },

    moveNodes: (nodeIds, newParentId, newIndex) => {
      if (nodeIds.length === 0) return
      // `struct-01` — a move on a studio-imported tree is written to the
      // user's `.tsx` as "put this element next to that sibling", so the
      // anchor has to be resolved against the tree BEFORE it changes.
      const tree = readTree()
      const plan = tree ? planSourceMove(tree, nodeIds, newParentId, newIndex) : null
      if (plan && !plan.ok) {
        toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, plan.refusal)
        return
      }
      mutateActiveTree((draft) => {
        moveNodes(draft, nodeIds, newParentId, newIndex)
        return true
      })
      const commit = plan?.commit
      if (commit) void commitStudioMove(commit.nodeId, commit.anchorNodeId, commit.position)
    },

    duplicateNode: (nodeId) => {
      if (refuseCopy('duplicate', [nodeId])) return ''
      let newId = ''
      let blockedByOutlet = false
      // Per-node "module-style" classes (scope.type === 'node') must be cloned
      // alongside the node — otherwise the duplicate's classIds carry the
      // source's class id and editing one node restyles both. F-0005.
      mutateActiveTreeAndSite((tree, site) => {
        if (!tree.nodes[nodeId]) return false
        // One-outlet-per-document invariant: the source subtree still holds the
        // outlet, so duplicating it would mint a second one.
        if (subtreeHasOutlet(tree.nodes, nodeId)) {
          blockedByOutlet = true
          return false
        }
        newId = duplicateNodeWithScopedClasses(tree, site, nodeId)
        return newId ? true : false
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'Duplicating this would create a second content outlet — a document can hold just one.',
        )
      }
      return newId
    },

    duplicateNodes: (nodeIds) => {
      if (nodeIds.length === 0) return []
      if (refuseCopy('duplicate', nodeIds)) return []
      const newIds: string[] = []
      let blockedByOutlet = false
      mutateActiveTreeAndSite((tree, site) => {
        for (const id of nodeIds) {
          // Skip the root and any id missing from the tree — duplicateNode
          // throws on the root, and silently skipping orphans matches the
          // delete/move guards.
          if (!tree.nodes[id] || id === tree.rootNodeId) continue
          // One-outlet-per-document invariant — same guard as duplicateNode.
          if (subtreeHasOutlet(tree.nodes, id)) {
            blockedByOutlet = true
            continue
          }
          newIds.push(duplicateNodeWithScopedClasses(tree, site, id))
        }
        return newIds.length > 0
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'Duplicating the content outlet was skipped — a document can hold just one.',
        )
      }
      return newIds
    },

    deleteNodes: createDeleteNodesAction(helpers),

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      if (refuseCopy('wrap', [nodeId])) return ''
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutateActiveTree((tree) => {
        wrapperId = wrapNode(tree, nodeId, containerModuleId, resolvedDefaults)
        return true
      })
      return wrapperId
    },

    wrapNodes: (nodeIds, containerModuleId, defaults = {}) => {
      if (nodeIds.length === 0) return null
      if (refuseCopy('wrap', nodeIds)) return null
      // Same defaults-resolution rule as `wrapNode` (Task #414 — defaults must
      // come from the module registry so the wrapper renders).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId: string | null = null
      // WS-7.3: a selection spanning several board frames wraps each page's
      // own subset independently — one wrapper node cannot hold children
      // from two different files. `wrapperId` ends up holding the LAST
      // touched page's wrapper id; existing single-page callers are
      // unaffected (`mutateTreesForNodeIds` takes the plain single-tree path
      // whenever every id is on one page/VC, so this stays the same one id
      // it always returned).
      mutateTreesForNodeIds(nodeIds, (tree, idsOnThisTree) => {
        const id = wrapNodes(tree, idsOnThisTree, containerModuleId, resolvedDefaults)
        if (id) wrapperId = id
        return true
      })
      return wrapperId
    },

    setNodeDynamicBinding: (nodeId, propKey, binding) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) return false
        const current = node.dynamicBindings?.[propKey]
        if (
          current &&
          current.source === binding.source &&
          current.field === binding.field &&
          current.format === binding.format &&
          current.fallback === binding.fallback
        ) {
          return false
        }
        node.dynamicBindings = {
          ...(node.dynamicBindings ?? {}),
          [propKey]: binding,
        }
        return true
      })
    },

    clearNodeDynamicBinding: (nodeId, propKey) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.dynamicBindings?.[propKey]) return false
        delete node.dynamicBindings[propKey]
        if (Object.keys(node.dynamicBindings).length === 0) {
          delete node.dynamicBindings
        }
        return true
      })
    },
  }

  return actions
}

