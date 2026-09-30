/**
 * importedNodesActions — an HTML fragment (`site_insert_html`,
 * `site_replace_node_html`, the paste-HTML importer) merged into the active
 * tree, and the one guard that refuses it on a studio-imported tree
 * (`mcp-21`: nanoid nodes in a real repository's board are an orphan no file
 * describes).
 *
 * Split out of `nodeActions.ts` (P3-D) at the module-size ceiling. It is a job
 * of its own: it merges a foreign node map and its `<style>` rules into the
 * site, which no other node action does.
 */
import { registry } from '@core/module-engine'
import { reindexNodeParents } from '@core/page-tree'
import { indexStyleRulesByName, linkImportedClassNames, mergeImportedStyleRules } from './importLinking'
import type { StudioSourceWrites } from './studioSourceWrites'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ImportedNodesActions = Pick<SiteSlice, 'insertImportedNodes' | 'refuseImportedNodesInto'>

export function createImportedNodesActions(
  helpers: SiteSliceHelpers,
  refuseImportedNodesInto: StudioSourceWrites['refuseImportedNodesInto'],
): ImportedNodesActions {
  const { mutateActiveTreeAndSite } = helpers

  const actions: ImportedNodesActions = {
    // `mcp-21` — the same guard `insertImportedNodes` runs, asked on its own by
    // the one caller that must destroy something before it can insert. See
    // `SiteSlice.refuseImportedNodesInto`.
    refuseImportedNodesInto: (parentId) => refuseImportedNodesInto(parentId),

    insertImportedNodes: (parentId, fragment, opts) => {
      if (fragment.rootIds.length === 0) return { ok: false, message: 'That HTML carried no elements to insert.' }
      // `mcp-21` — the studio-tree refusal rides the SAME guard as the
      // container check, so both reasons reach the caller as one sentence.
      const refusal = refuseImportedNodesInto(parentId, (newParentId) => {
        actions.insertImportedNodes(newParentId, fragment, opts)
      })
      if (refusal) return { ok: false, message: refusal }
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
      return insertedRootIds.length > 0
        ? { ok: true, rootIds: insertedRootIds }
        : { ok: false, message: 'That container does not accept children.' }
    },

  }

  return actions
}
