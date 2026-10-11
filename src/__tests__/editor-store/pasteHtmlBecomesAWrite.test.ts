/**
 * G-10 - pasting HTML onto a board backed by real files is a SOURCE WRITE, as
 * one gesture: one request, one history entry whose undo is the journal's
 * `restore`, and nothing minted on the canvas first.
 *
 * Two entry points reach the same store action (`writeHtmlToSource`): the
 * clipboard (⌘V with foreign `text/html` on it, `canvasPaste.ts`) and the
 * Import HTML dialog. The dialog is covered in
 * `admin/importHtmlModalOnSource.test.tsx`; the agent tool in
 * `agent/insertHtmlOnStudioTree.test.ts`. The fixture shares nothing with the
 * eSIM corpus: a swim club's lane-booking page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { runCanvasPaste } from '@site/canvas/canvasPaste'
import { UNREADABLE_CLIPBOARD } from '@site/canvas/canvasClipboardData'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetSourceIdentities } from '@site/studio/sourceIdentity'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import {
  CMS_SITE_RELOAD_EVENT,
  claimCmsSiteReloadRequests,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
} from '@admin/state/adminEvents'
import { applyStructuralWriteOutcome } from '@site/hooks/siteReloadApply'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const FILE = 'pages/Lanes.tsx'
const MAIN = `${FILE}:4:5`
const HEADING = `${FILE}:5:7`
const NOTE = `${FILE}:6:7`
const PASTED = `${FILE}:7:7`
const TOKEN = '0123456789abcdef0123456789abcdef'
const store = () => useEditorStore.getState()

/** The board as the editor reads it; `withPaste` is the re-read after the write landed. */
function loadStudioBoard(withPaste = false): void {
  store().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'lanes',
          rootNodeId: MAIN,
          nodes: {
            [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', children: withPaste ? [HEADING, NOTE, PASTED] : [HEADING, NOTE] }),
            [HEADING]: makeNode({ id: HEADING, moduleId: 'base.text', props: { text: 'Lanes' }, parentId: MAIN }),
            [NOTE]: makeNode({ id: NOTE, moduleId: 'base.text', props: { text: 'Note' }, parentId: MAIN }),
            ...(withPaste ? { [PASTED]: makeNode({ id: PASTED, moduleId: 'base.container', parentId: MAIN }) } : {}),
          },
        }),
      ],
    }),
  )
  store().setActivePage('lanes')
}

/** What the mounted editor does on a reload request: re-read the file, apply the write's outcome. */
let boardHasPaste = false
function onReload(): void {
  const covers = latestCmsSiteReloadRequest()
  loadStudioBoard(boardHasPaste)
  const claimed = claimCmsSiteReloadRequests(covers)
  for (const outcome of claimed.structuralOutcomes) applyStructuralWriteOutcome(outcome)
  claimed.settle()
}
let unregisterReloader: () => void

let posted: { edits: Record<string, unknown>[] }[]
let toasts: readonly Toast[]
let unsubscribe: (() => void) | null = null
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  resetStructuralCommitQueue()
  resetSourceIdentities()
  __resetToastBusForTests()
  posted = []
  toasts = []
  unsubscribe = subscribeToasts((next) => { toasts = next })
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      posted.push({ edits: body.edits ?? [] })
      boardHasPaste = (body.edits ?? []).some((edit: { kind?: string }) => edit.kind === 'insert')
      return new Response(
        JSON.stringify({
          ok: true,
          written: 1,
          skipped: 0,
          shifted: true,
          sharedComponents: false,
          undoToken: TOKEN,
          touchedFiles: [FILE, 'pages/lanes.css'],
          createdNodeIds: [PASTED],
          pastedHtml: [
            { stylesheet: 'pages/lanes.css', mode: 'global', rules: 2, inlined: 0, renamed: [{ from: 'lane', to: 'lane-2' }], skipped: ['a'], droppedDeclarations: 0 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  boardHasPaste = false
  unregisterReloader = registerCmsSiteReloader()
  window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  loadStudioBoard()
})

afterEach(() => {
  window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  unregisterReloader()
  globalThis.fetch = realFetch
  unsubscribe?.()
  resetStructuralCommitQueue()
  store().clearSite()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 200 && isStructuralCommitInFlight(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
}

const HTML = '<style>.lane { padding: 4px } a { color: red }</style><div class="lane"><a href="/book">Book</a></div>'

describe('⌘V with HTML on the clipboard, on a board written in real files', () => {
  it('writes it after the selected layer as one insert, with the CSS riding along', async () => {
    store().selectNode(HEADING)

    runCanvasPaste({ ...UNREADABLE_CLIPBOARD, readable: true, html: HTML })
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toEqual([
      {
        kind: 'insert',
        nodeId: MAIN,
        anchorNodeId: HEADING,
        position: 'after',
        name: 'div',
        props: { className: 'lane' },
        children: [{ name: 'a', props: { href: '/book' }, children: 'Book' }],
        pastedHtml: { css: '.lane { padding: 4px } a { color: red }' },
      },
    ])
    // Nothing was minted on the canvas: the elements arrive from the re-read file.
    expect(Object.keys(store().site!.pages[0]!.nodes).sort()).toContain(PASTED) // only because the test's re-read put it there
    expect(store()._historyPast).toHaveLength(1)
  })

  it('is one history entry whose undo is the journal restore, named for the user', async () => {
    store().selectNode(HEADING)
    runCanvasPaste({ ...UNREADABLE_CLIPBOARD, readable: true, html: HTML })
    await settle()

    expect(store()._historyPast).toHaveLength(1)
    expect(store()._historyPast[0]!.structural).toMatchObject({
      gesture: 'source',
      source: { label: 'Paste HTML', inverseTemplate: { kind: 'restore-journal' } },
    })

    store().undo()
    await settle()
    expect(posted).toHaveLength(2)
    expect(posted[1]!.edits).toEqual([expect.objectContaining({ kind: 'restore', token: TOKEN })])
  })

  it('tells the user where the styles went, with an Undo, and not as an error', async () => {
    store().selectNode(HEADING)
    runCanvasPaste({ ...UNREADABLE_CLIPBOARD, readable: true, html: HTML })
    await settle()

    const notice = toasts.find((toast) => toast.title.startsWith('Pasted'))
    expect(notice?.kind).toBe('info')
    expect(notice?.title).toBe('Pasted - 2 style rules added to lanes.css')
    expect(notice?.body).toContain('Renamed .lane to .lane-2')
    expect(notice?.body).toContain('Not written because they would restyle more than the pasted elements: a.')
    expect(notice?.action?.label).toBe('Undo')
    expect(toasts.filter((toast) => toast.kind === 'error' || toast.kind === 'warning')).toEqual([])
  })

  it('without a selection, appends to the end of the frame root', async () => {
    runCanvasPaste({ ...UNREADABLE_CLIPBOARD, readable: true, html: '<p>Tail</p>' })
    await settle()
    // No anchor means "append", which is the end of the root's children.
    expect(posted[0]!.edits[0]).toMatchObject({ kind: 'insert', nodeId: MAIN, name: 'p' })
    expect(posted[0]!.edits[0]).not.toHaveProperty('anchorNodeId')
  })

  it('refuses markup it cannot make safe, says so, and writes nothing', async () => {
    runCanvasPaste({ ...UNREADABLE_CLIPBOARD, readable: true, html: '<script>steal()</script>' })
    await settle()

    expect(posted).toHaveLength(0)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.kind).toBe('warning')
    expect(store()._historyPast).toHaveLength(0)
  })
})

describe('writeHtmlToSource on an ordinary CMS tree', () => {
  it('does nothing and says so, so the caller imports the HTML into the tree as before', async () => {
    store().clearSite()
    const site = store().createSite('Test')
    const result = store().writeHtmlToSource(HTML, site.pages[0]!.rootNodeId)
    await settle()
    expect(result).toEqual({ kind: 'cms' })
    expect(posted).toHaveLength(0)
  })
})
