/**
 * htmlTools — the three agent tools whose currency is a block of HTML:
 * `site_insert_html`, `site_get_node_html` and `site_replace_node_html`.
 *
 * Split out of `executor.ts` (the 700-line ceiling said so, and it was right):
 * these three share one pipeline nothing else in that file touches — parse the
 * HTML, strip what is unsafe, map it onto `PageNode`s, and read the `<style>`
 * block into registry rules — and one contract the rest of the toolset does
 * not have, which is that the whole fragment lands or none of it does
 * (`mcp-21`). The sibling split `cssTools.ts` / `documentTools.ts` /
 * `codeAssetTools.ts` already made is the same one.
 */
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type GetNodeHtmlInput,
  type InsertHtmlInput,
  type ReplaceNodeHtmlInput,
} from '@core/ai'
import { registry } from '@core/module-engine'
import { importHtml } from '@core/htmlImport'
import { renderNode, type RenderAccumulators, type RenderConfig } from '@core/publisher'
import { HTML_IMPORT_ON_SOURCE_REFUSAL } from '@site/store/slices/site/studioSourceRefusals'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'
import { parseImportedStyleCss } from './cssTools'
import {
  activeDocumentNodes,
  activeRenderPage,
  findNodeInActiveDoc,
  nodeNotInActiveDocError,
} from './documentTools'

// Live access to the editor store, the same way every sibling tool module
// reaches it — through `./storeRef`, so there is no static import edge back
// into the store's own module.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * `mcp-21` — the sentence an HTML import failure returns to the caller.
 *
 * The store decides WHY (the container will not take children, or this is a
 * studio-imported tree where a block of HTML has no honest source form) and
 * has already shown the user its own refusal; this forwards that sentence
 * rather than the invented one both failures used to share — for the studio
 * case, a sentence about containers that was never true.
 *
 * The studio refusal, and only that one, also names the toolset that DOES
 * write real code. Appending it to a CMS container refusal would be advice
 * about a project this call is not running against.
 */
function htmlImportFailure(message: string, targetNodeId: string): string {
  const remedy =
    message === HTML_IMPORT_ON_SOURCE_REFUSAL
      ? " On a Studio project write structure with the studio_* toolset instead: studio_apply_edits' insert edit writes real JSX into the file and returns a node id you can address."
      : ''
  return `${message} Target: ${targetNodeId}.${remedy}`
}

/**
 * Insert an HTML snippet as page nodes under `parentId`.
 *
 * Pipeline (identical to the paste-import modal path):
 *   1. importHtml(input.html) — parse → strip unsafe → walkAndMap → fragment
 *      (+ inline `style="…"` on node.inlineStyles, + raw `<style>` CSS).
 *   2. parseImportedStyleCss — `<style>` CSS → registry rules + conditions.
 *      `cssToStyleRules` classifies each selector: a bare `.foo` becomes a
 *      reusable class, anything else (`.hero a`, `a:hover`, …) an ambient rule.
 *   3. insertImportedNodes(parentId, fragment, { index, styleRules, conditions })
 *      — nodes, <style> rules, and class-token binding in one undo step.
 */
export function runInsertHtml(input: InsertHtmlInput): AiToolOutput {
  // (1) Parse and walk the HTML to produce a flat node fragment + any <style> CSS
  const { nodes, rootIds, styleCss, stripped } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload carries no elements but still carries authorable
    // CSS — reusable classes and ambient rules (`a:hover`, `.hero a`,
    // `::before`, …). Upsert them rather than discarding them. (The dedicated
    // `site_apply_css` tool is the canonical path for this; insertHtml stays forgiving
    // when a CSS-only payload arrives here.)
    if (rules.length > 0 || conditions.length > 0) {
      const result = getStoreState().applyCssRules(rules, conditions, 'merge')
      if (result.blockedSelectors.length > 0) {
        return aiToolError(
          `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
        )
      }
      return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
    }
    const scriptHint = stripped.scripts > 0 || stripped.inlineHandlers > 0
      ? ' Scripts and inline event handlers are stripped from HTML imports; create runtime behavior with site_write_code_asset({ type:"script", ... }) instead.'
      : ''
    return aiToolError(`HTML contained no importable elements or style rules.${scriptHint}`)
  }

  // (2) Insert via the store action — same path as the paste import modal
  const store = getStoreState()
  const inserted = store.insertImportedNodes(
    input.parentId,
    { nodes, rootIds },
    { index: input.index, styleRules: rules, conditions },
  )
  if (!inserted.ok) return aiToolError(htmlImportFailure(inserted.message, input.parentId))
  const insertedRootIds = inserted.rootIds

  // Return the full created subtree (id + module + class names) so the caller
  // can target nested nodes (e.g. the `.ist-shell` wrapper) without a separate
  // tree dump. `nodeIds` stays as the top-level roots for back-compat.
  // Read FRESH state after the insert — `store` above is the pre-insert
  // immutable snapshot, so its node map doesn't contain the new nodes (and its
  // styleRules lacks any classes insertImportedNodes auto-created).
  const postState = getStoreState()
  const nodeMap = activeDocumentNodes(postState) ?? {}
  const styleRules = postState.site?.styleRules ?? {}
  const created: Array<{ id: string; moduleId: string; classes: string[] }> = []
  const visit = (id: string): void => {
    const node = nodeMap[id]
    if (!node) return
    created.push({
      id,
      moduleId: node.moduleId,
      classes: (node.classIds ?? []).map((cid) => styleRules[cid]?.name ?? cid),
    })
    for (const childId of node.children) visit(childId)
  }
  for (const rootId of insertedRootIds) visit(rootId)

  return aiToolOk({ nodeIds: insertedRootIds, created })
}

/**
 * Render the subtree at `nodeId` to HTML using the publisher's renderNode.
 * Read-only — no store mutation.
 */
export function runGetNodeHtml(input: GetNodeHtmlInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')

  // Scope to the active document only. Visual components are materialized as
  // virtual pages so site_get_node_html and site_read_document share publisher semantics.
  const activePage = activeRenderPage(store)
  if (!activePage?.nodes[input.nodeId]) {
    return nodeNotInActiveDocError(store, input.nodeId)
  }

  const config: RenderConfig = {
    page: activePage,
    site,
    registry,
    breakpointId: undefined,
    annotateNodeIds: true,
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }

  const html = renderNode(input.nodeId, config, acc)
  return aiToolOk({ html })
}

/**
 * Replace the children of `nodeId` with an HTML snippet.
 *
 * The target node itself is preserved as the parent container. Its current
 * children (and their full subtrees) are deleted, then the imported HTML is
 * inserted in their place.
 */
export function runReplaceNodeHtml(input: ReplaceNodeHtmlInput): AiToolOutput {
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  // Verify the target node exists IN THE ACTIVE DOCUMENT — the only tree this
  // mutation can touch. A node from another page/template/VC must not resolve.
  const targetNode = findNodeInActiveDoc(store, input.nodeId)
  if (!targetNode) {
    return nodeNotInActiveDocError(store, input.nodeId)
  }

  // Parse + validate the payload BEFORE mutating, so an empty / invalid payload
  // never wipes the node's existing children first and then errors out.
  const { nodes, rootIds, styleCss, stripped } = importHtml(input.html)
  const { rules, conditions } = parseImportedStyleCss(styleCss)

  if (rootIds.length === 0) {
    // A <style>-only payload has nothing to replace the children WITH, so leave
    // the subtree intact and just upsert its rules — same forgiving behaviour
    // as insertHtml. Wiping children to insert nothing would be surprising.
    if (rules.length > 0 || conditions.length > 0) {
      const result = getStoreState().applyCssRules(rules, conditions, 'merge')
      if (result.blockedSelectors.length > 0) {
        return aiToolError(
          `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
        )
      }
      return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
    }
    const scriptHint = stripped.scripts > 0 || stripped.inlineHandlers > 0
      ? ' Scripts and inline event handlers are stripped from HTML imports; create runtime behavior with site_write_code_asset({ type:"script", ... }) instead.'
      : ''
    return aiToolError(`HTML contained no importable elements or style rules.${scriptHint}`)
  }

  // `mcp-21` — ask BEFORE destroying. This tool empties the target and then
  // refills it, so a refusal discovered at insert time would leave the node
  // empty and the file unchanged: half a gesture. On a studio-imported tree
  // the import always refuses (see `refuseImportedNodesInto`), which is
  // exactly the case that used to wipe the children first.
  const refusal = getStoreState().refuseImportedNodesInto(input.nodeId)
  if (refusal) return aiToolError(htmlImportFailure(refusal, input.nodeId))

  // Delete existing children so the target node is empty before insertion.
  const existingChildren = [...(targetNode.children ?? [])]
  if (existingChildren.length > 0) {
    getStoreState().deleteNodes(existingChildren)
  }

  const inserted = getStoreState().insertImportedNodes(
    input.nodeId,
    { nodes, rootIds },
    { styleRules: rules, conditions },
  )
  if (!inserted.ok) return aiToolError(htmlImportFailure(inserted.message, input.nodeId))

  return aiToolOk({ nodeIds: inserted.rootIds })
}
