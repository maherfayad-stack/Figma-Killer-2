/**
 * G-1 - a cross-frame move that carries what the element reads is still ONE
 * honest write and ONE byte-exact undo: the constants and handlers it reads
 * (G-1a), the state it uses (G-1b - the destination gets its own copy, and the
 * board says so with an Undo), a `.map` row's data (G-1c); and what cannot be
 * carried (a prop nothing gives a value to, a custom hook) refuses by name and
 * leaves every file as it was.
 *
 * Real end to end, in the style of `crossFrameMoveUndoRealSource.test.ts`:
 * `/save` is `applyStudioEditBatchLocked` against a temp workspace (journaled,
 * as the route runs it) and `/load` is `loadStudioPages` over the same files, so
 * the node ids the store moves are the ids the parser really minted, and the
 * undo is the journal's `restore` rather than a hand-scripted inverse.
 *
 * The fixture shares nothing with the eSIM corpus: a bakery's order screen and
 * its receipt screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import type { PageNode } from '@core/page-tree'
import { locateTag } from '../../core/ast-codemods/__tests__/fixtureLocation'
import { makeSite } from '../fixtures'
import { applyStudioEditBatchLocked } from '../../../server/handlers/studioWriteback'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { studioLoadStreamLines } from '../../../server/handlers/studio/studioLoadResponse'

const FORMAT = `export function formatPrice(n: number): string {
  return '$' + n
}
`

const ORDER = `import { formatPrice } from '../lib/format'

const TAX_RATE = 0.2
const money = (n: number) => formatPrice(n)

export default function Order() {
  const price = 40
  const qty = 3
  const total = price * qty * (1 + TAX_RATE)
  function pay() {
    console.log(money(total))
  }
  return (
    <main className="order">
      <h1>Order</h1>
      <button type="button" onClick={pay}>
        Pay {money(total)}
      </button>
    </main>
  )
}
`

const RECEIPT = `export default function Receipt() {

  return (
    <main className="receipt">
      <h1>Receipt</h1>
    </main>
  )
}
`

const STATEFUL = `import { useState } from 'react'

export default function Stateful() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(!open)
  return (
    <main className="stateful">
      <button type="button" onClick={toggle}>
        Toggle
      </button>
    </main>
  )
}
`

const ROWS = `const RACES = [
  { id: 'fell', name: 'Fell Run' },
  { id: 'ridge', name: 'Ridge Ultra' },
]

export default function Rows() {
  return (
    <main className="rows">
      <ul>
        {RACES.map((race) => (
          <li key={race.id}>
            <b>{race.name}</b>
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const CUSTOM = `import { useToggle } from '../lib/useToggle'

export default function Custom() {
  const [open, toggle] = useToggle(false)
  return (
    <main className="custom">
      <button type="button" onClick={toggle}>
        {open ? 'Hide' : 'Show'}
      </button>
    </main>
  )
}
`

const PROPPED = `export default function Propped({ qty }: { qty: number }) {
  const label = qty + ' loaves'
  return (
    <main className="propped">
      <p>{label}</p>
    </main>
  )
}
`

let dir: string
let originalFetch: typeof globalThis.fetch
let unregisterSave: (() => void) | null = null
let patchListener: ((evt: Event) => void) | null = null

const read = (rel: string) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
function write(rel: string, text: string): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface SaveResponse {
  refusals?: { kind: string; reason: string; message: string }[]
  written: number
}

/** `/save` is the real batch; `/load` is the real parse of the same files. */
function installRealServer(saves: { edits: { kind: string }[] }[], responses: SaveResponse[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = url.split('?')[0]
    if (route === '/admin/api/studio/save') {
      const body = JSON.parse(String(init?.body)) as {
        edits: Parameters<typeof applyStudioEditBatchLocked>[1]
        expect?: Parameters<typeof applyStudioEditBatchLocked>[2]
      }
      const result = await applyStudioEditBatchLocked(dir, body.edits, body.expect ?? {}, {
        canvasLayers: 'allow',
        journal: true,
      })
      saves.push({ edits: [...body.edits] })
      responses.push({ written: result.written, ...(result.refusals ? { refusals: result.refusals } : {}) })
      return new Response(
        JSON.stringify({
          ok: true,
          ...result,
          touchedFiles: result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')),
        }),
        { status: 200 },
      )
    }
    if (route === '/admin/api/studio/reload-scope') {
      const pages = (await loadStudioPages(dir)).pages
      return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: pages.map((p) => p.id) }), { status: 200 })
    }
    if (route === '/admin/api/studio/load') {
      const result = await loadStudioPages(dir)
      const lines: string[] = []
      for await (const line of studioLoadStreamLines({
        ...result,
        dir,
        projectName: 'bakery',
        trust: 'static',
        projectKey: null,
        paletteHiddenModuleIds: [],
        missingPageIds: undefined,
      })) {
        lines.push(JSON.stringify(line))
      }
      return new Response(lines.join('\n') + '\n', { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

/** The page of `file` and the node at `<tag` in it, exactly as the parser minted them. */
function pageAndNode(file: string, source: string, tag: string): { pageId: string; node: PageNode } {
  const at = locateTag(source, tag)
  const id = `${file}.tsx:${at.line}:${at.col}`
  const page = useEditorStore.getState().site!.pages.find((candidate) => id in candidate.nodes)!
  return { pageId: page.id, node: page.nodes[id]! }
}

describe('G-1a - a cross-frame move that carries constants and handlers', () => {
  let saves: Parameters<typeof installRealServer>[0]
  let responses: SaveResponse[]

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-xframe-carry-'))
    write('pages/Order.tsx', ORDER)
    write('pages/Receipt.tsx', RECEIPT)
    write('pages/Stateful.tsx', STATEFUL)
    write('pages/Propped.tsx', PROPPED)
    write('pages/Rows.tsx', ROWS)
    write('pages/Custom.tsx', CUSTOM)
    write('lib/format.ts', FORMAT)
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saves = []
    responses = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir(dir)
    installRealServer(saves, responses)

    patchListener = (evt: Event) => {
      applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    }
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)

    const loaded = await loadStudioPages(dir)
    useEditorStore.getState().loadSite(makeSite({ pages: loaded.pages, styleRules: loaded.styleRules }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    useEditorStore.getState().clearSite()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function transplantTo(origin: { pageId: string; node: PageNode }, destFile: string, destSource: string): void {
    const target = pageAndNode(destFile, destSource, 'main')
    useEditorStore.getState().transplantNodes([origin.node.id], {
      originPageId: origin.pageId,
      pageId: target.pageId,
      parentId: target.node.id,
      index: target.node.children.length,
    })
  }

  it('moves the pay button with its constants, handler and private helpers, then one undo restores BOTH files byte for byte', async () => {
    transplantTo(pageAndNode('pages/Order', ORDER, 'button'), 'pages/Receipt', RECEIPT)
    await waitFor(() => saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    expect(responses[0]!.refusals ?? []).toEqual([])
    const receipt = read('pages/Receipt.tsx')
    expect(receipt).toContain("import { formatPrice } from '../lib/format'")
    expect(receipt).toContain('const money = (n: number) => formatPrice(n)')
    expect(receipt).toContain('const TAX_RATE = 0.2')
    expect(receipt).toContain('  const total = price * qty * (1 + TAX_RATE)\n')
    expect(receipt).toContain('  function pay() {\n    console.log(money(total))\n  }\n')
    expect(receipt).toContain('<button type="button" onClick={pay}>')
    // The origin lost the button and keeps its own constants.
    const order = read('pages/Order.tsx')
    expect(order).not.toContain('<button')
    expect(order).toContain('const total = price * qty * (1 + TAX_RATE)')

    // The parser reads the written destination: main, the heading and the button.
    const reparsed = (await loadStudioPages(dir)).pages.find((page) => page.id === 'receipt')!
    expect(Object.keys(reparsed.nodes).filter((id) => id.startsWith('pages/Receipt.tsx:'))).toHaveLength(3)

    useEditorStore.getState().undo()
    await waitFor(() => saves.length === 2)
    await waitFor(() => !useEditorStore.getState().canUndo)

    expect(saves[1]!.edits[0]!.kind).toBe('restore')
    expect(read('pages/Order.tsx')).toBe(ORDER)
    expect(read('pages/Receipt.tsx')).toBe(RECEIPT)
  })

  it('gives the destination its own copy of the state, says so with an Undo, and one undo restores BOTH files byte for byte', async () => {
    let toasts: readonly Toast[] = []
    const stop = subscribeToasts((next) => {
      toasts = next
    })
    try {
      transplantTo(pageAndNode('pages/Stateful', STATEFUL, 'button'), 'pages/Receipt', RECEIPT)
      await waitFor(() => saves.length === 1)
      await waitFor(() => useEditorStore.getState().canUndo)
      await waitFor(() => toasts.some((toast) => toast.title.includes('state')))

      expect(responses[0]!.refusals ?? []).toEqual([])
      const receipt = read('pages/Receipt.tsx')
      expect(receipt).toContain("import { useState } from 'react'")
      expect(receipt).toContain('const [open, setOpen] = useState(false)')
      expect(receipt).toContain('const toggle = () => setOpen(!open)')
      expect(receipt).toContain('<button type="button" onClick={toggle}>')
      // The origin keeps its own state.
      expect(read('pages/Stateful.tsx')).toContain('const [open, setOpen] = useState(false)')

      // One info notice, with the board's own Undo on it - not an error.
      const notice = toasts.find((toast) => toast.title.includes('state'))!
      expect(notice.kind).toBe('info')
      expect(notice.title).toContain('open, setOpen')
      expect(notice.action?.label).toBe('Undo')
      void notice.action!.onSelect()

      await waitFor(() => saves.length === 2)
      await waitFor(() => !useEditorStore.getState().canUndo)
      expect(saves[1]!.edits[0]!.kind).toBe('restore')
      expect(read('pages/Stateful.tsx')).toBe(STATEFUL)
      expect(read('pages/Receipt.tsx')).toBe(RECEIPT)
    } finally {
      stop()
    }
  })

  it('refuses a custom hook result, names the hook, and writes neither file', async () => {
    transplantTo(pageAndNode('pages/Custom', CUSTOM, 'button'), 'pages/Receipt', RECEIPT)
    await waitFor(() => saves.length === 1)

    expect(responses[0]!.written).toBe(0)
    expect(responses[0]!.refusals?.[0]).toMatchObject({ kind: 'transplant', reason: 'captured-scope' })
    expect(responses[0]!.refusals?.[0]?.message).toContain('useToggle()')
    expect(read('pages/Custom.tsx')).toBe(CUSTOM)
    expect(read('pages/Receipt.tsx')).toBe(RECEIPT)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('drags an element out of a .map row: a copy of that row, the list untouched, one undo, an info notice', async () => {
    let toasts: readonly Toast[] = []
    const stop = subscribeToasts((next) => {
      toasts = next
    })
    try {
      const at = locateTag(ROWS, 'b')
      const page = useEditorStore.getState().site!.pages.find((candidate) => `pages/Rows.tsx:${at.line}:${at.col}#1` in candidate.nodes)!
      const rowNode = page.nodes[`pages/Rows.tsx:${at.line}:${at.col}#1`]!
      transplantTo({ pageId: page.id, node: rowNode }, 'pages/Receipt', RECEIPT)
      await waitFor(() => saves.length === 1)
      await waitFor(() => useEditorStore.getState().canUndo)

      expect(responses[0]!.refusals ?? []).toEqual([])
      expect(read('pages/Rows.tsx')).toBe(ROWS)
      const receipt = read('pages/Receipt.tsx')
      expect(receipt).toContain("const race = { id: 'ridge', name: 'Ridge Ultra' }")
      expect(receipt).toContain('<b>{race.name}</b>')
      await waitFor(() => toasts.some((toast) => toast.title.includes('values')))
      expect(toasts.find((toast) => toast.title.includes('values'))!.kind).toBe('info')

      useEditorStore.getState().undo()
      await waitFor(() => saves.length === 2)
      expect(saves[1]!.edits[0]!.kind).toBe('restore')
      expect(read('pages/Rows.tsx')).toBe(ROWS)
      expect(read('pages/Receipt.tsx')).toBe(RECEIPT)
    } finally {
      stop()
    }
  })

  it('refuses a constant computed from a prop, names the prop, and writes neither file', async () => {
    transplantTo(pageAndNode('pages/Propped', PROPPED, 'p'), 'pages/Receipt', RECEIPT)
    await waitFor(() => saves.length === 1)

    expect(responses[0]!.written).toBe(0)
    expect(responses[0]!.refusals?.[0]?.reason).toBe('captured-scope')
    expect(responses[0]!.refusals?.[0]?.message).toContain('"qty"')
    expect(read('pages/Propped.tsx')).toBe(PROPPED)
    expect(read('pages/Receipt.tsx')).toBe(RECEIPT)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })
})
