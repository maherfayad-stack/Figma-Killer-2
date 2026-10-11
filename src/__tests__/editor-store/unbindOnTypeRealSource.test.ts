/**
 * G-6 (OD-20) - typing over a code-bound text or attribute commits the literal,
 * names what it replaced, and one undo (the toast's button or Cmd+Z) puts every
 * byte back; what has no single honest target (a shared component's markup, a
 * `.map` row, markup in the position) stays refused and writes nothing.
 *
 * Real end to end, in the style of `crossFrameCarryScopeRealSource.test.ts`:
 * `/save` is the journaled `applyStudioEditBatchLocked` against a temp workspace
 * and `/load` is `loadStudioPages` over the same files, so the node ids and the
 * `codeProps` the store reasons about are what the parser really minted.
 *
 * The fixture shares nothing with the eSIM corpus: a coffee shop's menu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { commitUnbindIfCodeBound } from '@site/inspector/commitUnbind'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { canUnbindProp, explainPropConstraint, type PageNode } from '@core/page-tree'
import { locateTag } from '../../core/ast-codemods/__tests__/fixtureLocation'
import { makeSite } from '../fixtures'
import { applyStudioEditBatchLocked } from '../../../server/handlers/studioWriteback'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { studioLoadStreamLines } from '../../../server/handlers/studio/studioLoadResponse'

const MENU = `import { useState } from 'react'
import { Badge } from '../components/Badge'

export default function Menu({ mood }: { mood: string }) {
  const [cups] = useState(0)
  const heading = 'Today' + ' only'
  return (
    <main className="menu">
      <h1>{heading}</h1>
      <p title={heading}>{cups}</p>
      <ul>
        {['latte', 'mocha'].map((drink) => (
          <li key={drink}>{drink}</li>
        ))}
      </ul>
      <img src="/latte.png" alt={mood} />
      <Badge label="new" />
    </main>
  )
}
`

const BADGE = `export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>
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

/** What the toast bus holds right now. */
function currentToasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((toasts) => {
    snapshot = [...toasts]
  })()
  return snapshot
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface SaveRecord {
  edits: Record<string, unknown>[]
  refusals: { kind: string; reason: string; message: string }[]
  written: number
}

/** `/save` is the real journaled batch; `/load` is the real parse of the same files. */
function installRealServer(saves: SaveRecord[]) {
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
      saves.push({ edits: [...body.edits] as Record<string, unknown>[], refusals: result.refusals, written: result.written })
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
        projectName: 'coffee',
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

/** The node at `<tag` of `MENU`, exactly as the parser minted it. */
function menuNode(tag: string, occurrence = 1): PageNode {
  const at = locateTag(MENU, tag, occurrence)
  const id = `pages/Menu.tsx:${at.line}:${at.col}`
  const page = useEditorStore.getState().site!.pages.find((candidate) => id in candidate.nodes)!
  return page.nodes[id]!
}

describe('G-6 - typing over code-bound text and attributes', () => {
  let saves: SaveRecord[]

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unbind-type-'))
    write('pages/Menu.tsx', MENU)
    write('components/Badge.tsx', BADGE)
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saves = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir(dir)
    installRealServer(saves)

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

  it('replaces a resolved text with the typed one, names the code it replaced, and Undo restores every byte', async () => {
    const heading = menuNode('h1')
    expect(heading.codeProps).toContain('text')

    expect(useEditorStore.getState().unbindNodeValue(heading.id, 'text', 'Fresh beans')).toBe(true)
    await waitFor(() => saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    expect(saves[0]!.refusals).toEqual([])
    expect(saves[0]!.edits[0]).toMatchObject({ kind: 'text', nodeId: heading.id, text: 'Fresh beans', unbind: true })
    expect(read('pages/Menu.tsx')).toBe(MENU.replace('<h1>{heading}</h1>', '<h1>Fresh beans</h1>'))

    // The notice says what went and carries the button that takes it back.
    await waitFor(() => currentToasts().some((toast) => toast.title.startsWith('Replaced')))
    const notice = currentToasts().find((toast) => toast.title.startsWith('Replaced'))!
    expect(notice.kind).toBe('info')
    expect(notice.title).toBe('Replaced {heading} with text')
    expect(notice.action?.label).toBe('Undo')

    // The toast button IS the store's undo: it posts the journal's `restore`.
    await notice.action!.onSelect()
    await waitFor(() => saves.length === 2)
    await waitFor(() => !useEditorStore.getState().canUndo)
    expect(saves[1]!.edits[0]!.kind).toBe('restore')
    expect(read('pages/Menu.tsx')).toBe(MENU)
    expect(read('components/Badge.tsx')).toBe(BADGE)
  })

  it('replaces a code-bound attribute through the same route the panel field uses', async () => {
    const paragraph = menuNode('p')
    expect(paragraph.codeProps).toContain('title')

    // `commitUnbindIfCodeBound` is the one routing question the panel, the
    // inspector sections and the in-place inspector all ask.
    expect(commitUnbindIfCodeBound(paragraph, 'title', 'Fresh beans')).toBe(true)
    await waitFor(() => saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    expect(saves[0]!.edits[0]).toMatchObject({ kind: 'prop', prop: 'title', value: 'Fresh beans', unbind: true })
    expect(read('pages/Menu.tsx')).toBe(MENU.replace('<p title={heading}>', '<p title="Fresh beans">'))

    useEditorStore.getState().undo()
    await waitFor(() => saves.length === 2)
    expect(read('pages/Menu.tsx')).toBe(MENU)
  })

  it('replaces an attribute the parser could not resolve at all (a prop of the page) the same way', async () => {
    const image = menuNode('img')
    expect(image.codeProps).toContain('alt')

    expect(useEditorStore.getState().unbindNodeValue(image.id, 'alt', 'Latte art')).toBe(true)
    await waitFor(() => saves.length === 1)
    expect(read('pages/Menu.tsx')).toBe(MENU.replace('alt={mood}', 'alt="Latte art"'))
  })

  it('offers the typed-over field only where there is one honest place to write', () => {
    const state = useEditorStore.getState()
    const heading = menuNode('h1')
    const row = state.site!.pages.flatMap((page) => Object.values(page.nodes)).find((node) => node.id.includes('#'))
    // The heading and the image are plain source locations; a `.map` row is not.
    expect(canUnbindProp(heading, 'text')).toBe(true)
    expect(explainPropConstraint(heading, 'text', heading.props.text)?.unbindable).toBe(true)
    expect(canUnbindProp(menuNode('img'), 'alt')).toBe(true)
    // A literal prop is just written; it is never "unbound".
    expect(canUnbindProp(menuNode('img'), 'src')).toBe(false)
    if (row) {
      expect(canUnbindProp(row, 'text')).toBe(false)
      expect(explainPropConstraint(row, 'text', row.props.text)?.unbindable).toBeUndefined()
    }
  })

  it('a canvas double-click session over code-bound text commits through the unbind write, and cancelling writes nothing', async () => {
    const heading = menuNode('h1')
    const state = () => useEditorStore.getState()

    expect(state().startInlineEdit(heading.id, 'base')).toBe(true)
    expect(state().activeInlineEdit?.unbind).toBe(true)
    // The session opens on what the canvas shows, not on an empty box.
    expect(state().activeInlineEdit?.initialValue).toBe(heading.props.text as string)
    state().cancelInlineEdit()
    expect(saves).toHaveLength(0)

    expect(state().startInlineEdit(heading.id, 'base')).toBe(true)
    state().endInlineEdit() // no change: no write
    expect(saves).toHaveLength(0)

    expect(state().startInlineEdit(heading.id, 'base')).toBe(true)
    state().applyInlineEditValue('Typed on the canvas')
    state().endInlineEdit()
    await waitFor(() => saves.length === 1)
    expect(read('pages/Menu.tsx')).toBe(MENU.replace('<h1>{heading}</h1>', '<h1>Typed on the canvas</h1>'))
  })

  it('starts nothing, and writes nothing, where there is no single honest place to write', async () => {
    const state = useEditorStore.getState()
    const image = menuNode('img')

    // A literal attribute is simply written; typing over it is not "unbinding".
    expect(state.unbindNodeValue(image.id, 'src', 'x.png')).toBe(false)
    // A node the board does not hold.
    expect(state.unbindNodeValue('pages/Menu.tsx:99:1', 'text', 'x')).toBe(false)

    // The ids that have no single place: a `.map` row, markup inlined from a
    // shared component, an instance's call-site prop, an inline-style property.
    const code = { codeProps: ['text', 'alt', 'style:color', 'callSiteProps:label'] }
    expect(canUnbindProp({ ...code, id: 'pages/Menu.tsx:12:11#1' }, 'text')).toBe(false)
    expect(canUnbindProp({ ...code, id: 'pages/Menu.tsx:15:8~components/Badge.tsx:2:23' }, 'text')).toBe(false)
    expect(canUnbindProp({ ...code, id: 'pages/Menu.tsx:15:8' }, 'callSiteProps:label')).toBe(false)
    expect(canUnbindProp({ ...code, id: 'pages/Menu.tsx:15:8' }, 'style:color')).toBe(false)
    // ...and a value the parser traced to ONE dictionary literal is edited THERE, not unbound.
    expect(canUnbindProp({ ...code, id: 'pages/Menu.tsx:15:8', resolvedProps: { text: { origin: { rel: 'i18n.ts', line: 1, col: 1 } } } }, 'text')).toBe(false)

    expect(saves).toHaveLength(0)
    expect(read('pages/Menu.tsx')).toBe(MENU)
    expect(state.canUndo).toBe(false)
  })
})
