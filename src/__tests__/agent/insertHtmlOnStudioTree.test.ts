/**
 * `mcp-21`'s open defect, closed: `site_insert_html` / `site_replace_node_html`
 * on a studio-imported tree.
 *
 * The tools run `importHtml` and hand the fragment to `insertImportedNodes`,
 * which merged it into the page as nanoid nodes and posted NO source write.
 * On a board whose source of truth is a real `.tsx`, that is an orphan: the
 * elements show on the canvas until the next parse and then silently do not.
 * It is reachable without any UI at all — an external MCP client holding
 * `ai.tools.write` can call both tools through the editor bridge.
 *
 * The fix is a refusal, not a source write, and the reasoning is in
 * `refuseImportedNodesInto`. What these tests hold is the part that matters at
 * the boundary: **nothing is ever half-applied**. The tree is byte-identical
 * after a refused call, no request goes out, and the model is told why and
 * what to use instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const PAGE_ID = 'home'
const CONTAINER_ID = 'pages/Home.tsx:4:5'
const ROW_ID = 'pages/Home.tsx:5:7'

/** A board read out of a real repository: every node id is a `rel:line:col`. */
function loadStudioBoard(): void {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: PAGE_ID,
          rootNodeId: CONTAINER_ID,
          nodes: {
            [CONTAINER_ID]: makeNode({ id: CONTAINER_ID, moduleId: 'base.container', children: [ROW_ID] }),
            [ROW_ID]: makeNode({ id: ROW_ID, moduleId: 'base.text', props: { text: 'Row' } }),
          },
        }),
      ],
    }),
  )
  useEditorStore.getState().setActivePage(PAGE_ID)
}

const nodeIds = (): string[] => Object.keys(useEditorStore.getState().site!.pages[0]!.nodes).sort()

describe('site_insert_html on a studio-imported tree', () => {
  let originalFetch: typeof globalThis.fetch
  let requests: string[]
  let toasts: readonly Toast[]
  let unsubscribe: (() => void) | null = null

  beforeEach(() => {
    __resetToastBusForTests()
    originalFetch = globalThis.fetch
    requests = []
    toasts = []
    unsubscribe = subscribeToasts((next) => { toasts = next })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(typeof input === 'string' ? input : input.toString())
      return new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch
    loadStudioBoard()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unsubscribe?.()
    useEditorStore.getState().clearSite()
  })

  it('refuses rather than merging nodes the next parse would delete', async () => {
    const before = nodeIds()

    const result = await executeAgentTool('site_insert_html', {
      parentId: CONTAINER_ID,
      html: '<section><h1>Hello</h1><a href="/">Go</a></section>',
    })

    expect(result.ok).toBe(false)
    expect(nodeIds()).toEqual(before)
    // Nothing reached the network either — a refusal is decided before a write.
    expect(requests.filter((url) => url.includes('/admin/api/studio/save'))).toHaveLength(0)
  })

  it('says why, and names the toolset that does write real code', async () => {
    const result = await executeAgentTool('site_insert_html', {
      parentId: CONTAINER_ID,
      html: '<p>Hello</p>',
    })

    expect(result.error).toContain('written back into your project')
    expect(result.error).toContain('studio_apply_edits')
  })

  it('tells the user too, once, through the ordinary refusal channel', async () => {
    await executeAgentTool('site_insert_html', { parentId: CONTAINER_ID, html: '<p>Hello</p>' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.body).toContain('written back into your project')
  })

  it('refuses site_replace_node_html without first wiping the children it was replacing', async () => {
    const before = nodeIds()

    const result = await executeAgentTool('site_replace_node_html', {
      nodeId: CONTAINER_ID,
      html: '<p>Replacement</p>',
    })

    expect(result.ok).toBe(false)
    // The old children are still there. `runReplaceNodeHtml` deletes them
    // before inserting, so a refusal that arrived late would leave the node
    // empty — the half-applied outcome this whole path exists to avoid.
    expect(nodeIds()).toEqual(before)
    expect(useEditorStore.getState().site!.pages[0]!.nodes[CONTAINER_ID]!.children).toEqual([ROW_ID])
  })

  it('still imports HTML normally on an ordinary CMS tree', async () => {
    useEditorStore.getState().clearSite()
    const site = useEditorStore.getState().createSite('Test')
    const rootId = site.pages[0]!.rootNodeId

    const result = await executeAgentTool('site_insert_html', {
      parentId: rootId,
      html: '<section><h1>Hello</h1></section>',
    })

    expect(result.ok).toBe(true)
    expect((result.data as { nodeIds: string[] }).nodeIds.length).toBeGreaterThan(0)
  })
})
