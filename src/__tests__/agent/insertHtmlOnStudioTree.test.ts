/**
 * `site_insert_html` / `site_replace_node_html` on a studio-imported tree.
 *
 * `mcp-21` found that the tools ran `importHtml` and handed the fragment to
 * `insertImportedNodes`, which merged it into the page as nanoid nodes and
 * posted NO source write: on a board whose source of truth is a real `.tsx`
 * that is an orphan that shows until the next parse and then silently is not.
 * It was closed with a refusal. G-10 closes it properly for the INSERT: the HTML
 * is converted to JSX and written with its styles, as one `insert` edit. What
 * these tests hold is the part that matters at the boundary:
 *
 *  - an insert posts exactly one write and merges NOTHING into the tree (the
 *    elements arrive from the re-read file, with real ids);
 *  - hostile markup never reaches the request;
 *  - a replace - which would delete then insert, two writes - still refuses
 *    before it destroys anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
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

interface Posted {
  edits: Record<string, unknown>[]
}

describe('site_insert_html on a studio-imported tree', () => {
  let originalFetch: typeof globalThis.fetch
  let saves: Posted[]
  let toasts: readonly Toast[]
  let unsubscribe: (() => void) | null = null

  beforeEach(() => {
    resetStructuralCommitQueue()
    __resetToastBusForTests()
    originalFetch = globalThis.fetch
    saves = []
    toasts = []
    unsubscribe = subscribeToasts((next) => { toasts = next })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.includes('/studio/save')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        saves.push({ edits: body.edits ?? [] })
        return new Response(
          JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    loadStudioBoard()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unsubscribe?.()
    resetStructuralCommitQueue()
    useEditorStore.getState().clearSite()
  })

  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('writes the HTML as one insert edit and merges nothing into the tree', async () => {
    const before = nodeIds()

    const result = await executeAgentTool('site_insert_html', {
      parentId: CONTAINER_ID,
      html: '<style>.hero { padding: 8px }</style><section class="hero"><h1>Hello</h1><a href="/">Go</a></section>',
    })
    await settle()

    expect(result.ok).toBe(true)
    expect((result.data as { nodeIds: string[]; writtenToSource: boolean }).writtenToSource).toBe(true)
    // The elements do not exist until the codemod has written them: no nanoid node is minted.
    expect(nodeIds()).toEqual(before)
    expect(saves).toHaveLength(1)
    expect(saves[0]!.edits).toHaveLength(1)
    expect(saves[0]!.edits[0]).toMatchObject({
      kind: 'insert',
      nodeId: CONTAINER_ID,
      name: 'section',
      props: { className: 'hero' },
      children: [
        { name: 'h1', children: 'Hello' },
        { name: 'a', props: { href: '/' }, children: 'Go' },
      ],
      pastedHtml: { css: '.hero { padding: 8px }' },
    })
  })

  it('never lets a script, a handler or a javascript: link into the request', async () => {
    const result = await executeAgentTool('site_insert_html', {
      parentId: CONTAINER_ID,
      html: '<div><script>steal()</script><img src="x" onerror="steal()"><a href="javascript:steal()">go</a><b>ok</b></div>',
    })
    await settle()

    expect(result.ok).toBe(true)
    expect(saves).toHaveLength(1)
    const wire = JSON.stringify(saves[0]!.edits)
    expect(wire).not.toMatch(/steal|onerror|javascript|script/i)
    expect(wire).toContain('"ok"')
    // The user is told what was left out, once.
    expect(toasts.map((toast) => toast.body ?? '').join(' ')).toContain('1 script, 1 event handler, 1 unsafe link')
  })

  it('refuses HTML with no elements, with a sentence, and posts nothing', async () => {
    const result = await executeAgentTool('site_insert_html', { parentId: CONTAINER_ID, html: '<style>.a { color: red }</style>' })
    await settle()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('only a stylesheet')
    expect(saves).toHaveLength(0)
    expect(toasts).toHaveLength(1)
  })

  it('refuses site_replace_node_html without first wiping the children it was replacing', async () => {
    const before = nodeIds()

    const result = await executeAgentTool('site_replace_node_html', {
      nodeId: CONTAINER_ID,
      html: '<p>Replacement</p>',
    })
    await settle()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('two writes')
    expect(result.error).toContain('site_insert_html')
    // The old children are still there. `runReplaceNodeHtml` deletes them
    // before inserting, so a refusal that arrived late would leave the node
    // empty - the half-applied outcome this whole path exists to avoid.
    expect(nodeIds()).toEqual(before)
    expect(useEditorStore.getState().site!.pages[0]!.nodes[CONTAINER_ID]!.children).toEqual([ROW_ID])
    expect(saves).toHaveLength(0)
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
    expect(saves).toHaveLength(0)
  })
})
