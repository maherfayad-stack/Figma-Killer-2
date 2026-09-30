/**
 * P5-B3 — the Assets panel's Images section (IMG-6) and its unused-image
 * footer (IMG-11).
 *
 *  - Every image in the project is a card; search narrows by path.
 *  - A card adds the image WITHOUT uploading it: the store is handed a
 *    `project` source, and the insert only references the file.
 *  - The footer offers only what the server reports unused, and deletes
 *    nothing until the confirmation is accepted — then exactly those paths.
 *
 * The routes are stubbed at `fetch`, the one transport `apiRequest` uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { ImagesSection } from '@site/panels/AssetsPanel/ImagesSection'
import { useEditorStore } from '@site/store/store'
import type { ImageDropRequest } from '@site/store/slices/site/imageDropShapes'
import { invalidateProjectImageAssets } from '@site/studio/projectAssets'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const realFetch = globalThis.fetch

const ASSETS = [
  { relPath: 'public/brand/logo.svg', src: '/brand/logo.svg', buildSafe: true },
  { relPath: 'public/hero.png', src: '/hero.png', buildSafe: true },
  { relPath: 'src/assets/team.jpg', src: '/src/assets/team.jpg', buildSafe: false },
]

let unused: string[] = []
let pruned: string[][] = []

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let drops: ImageDropRequest[] = []
const realDrop = useEditorStore.getState().dropImagesIntoPage

beforeEach(() => {
  unused = []
  pruned = []
  drops = []
  invalidateProjectImageAssets()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/project-assets')) return json({ assets: ASSETS })
    if (url.includes('/admin/api/studio/asset-ledger')) {
      return json({ unused: unused.map((relPath) => ({ relPath, bytes: 10 })), incomplete: false })
    }
    if (url.includes('/admin/api/studio/asset-prune')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { relPaths: string[] }
      pruned.push(body.relPaths)
      return json({ deleted: body.relPaths, kept: [] })
    }
    return json({})
  }) as typeof fetch

  const home = makePage({
    id: 'home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'home:body',
    nodes: {
      'home:body': makeNode({ id: 'home:body', moduleId: 'base.container', children: ['pages/Home.tsx:4:5'] }),
      'pages/Home.tsx:4:5': makeNode({ id: 'pages/Home.tsx:4:5', moduleId: 'base.container', parentId: 'home:body' }),
    },
  })
  useEditorStore.getState().loadSite(makeSite({ pages: [home] }))
  useEditorStore.setState({
    activePageId: 'home',
    selectedNodeId: 'pages/Home.tsx:4:5',
    dropImagesIntoPage: (drop: ImageDropRequest) => {
      drops.push(drop)
    },
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  useEditorStore.setState({ dropImagesIntoPage: realDrop } as Parameters<typeof useEditorStore.setState>[0])
})

function renderSection(query = '') {
  return render(
    <ConfirmDeleteProvider>
      <ImagesSection query={query} collapsed={false} onToggle={() => {}} />
    </ConfirmDeleteProvider>,
  )
}

describe('ImagesSection — the project images (IMG-6)', () => {
  it('shows one card per image in the project', async () => {
    renderSection()
    await waitFor(() => expect(screen.getAllByTestId('assets-image-card')).toHaveLength(3))
    expect(screen.getAllByTestId('assets-image-card').map((card) => card.getAttribute('data-asset-path'))).toEqual(
      ASSETS.map((asset) => asset.relPath),
    )
  })

  it('search narrows by path', async () => {
    renderSection('brand')
    await waitFor(() => expect(screen.getAllByTestId('assets-image-card')).toHaveLength(1))
    expect(screen.getByTestId('assets-image-card').getAttribute('data-asset-path')).toBe('public/brand/logo.svg')
  })

  it('a click adds the image beside the selection as a PROJECT source — nothing uploaded', async () => {
    renderSection()
    await waitFor(() => expect(screen.getAllByTestId('assets-image-card')).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Add image hero.png' }))

    expect(drops).toHaveLength(1)
    const drop = drops[0]!
    expect(drop.pageId).toBe('home')
    expect(drop.parentId).toBe('home:body')
    expect(drop.index).toBe(1)
    expect(drop.sources).toEqual([
      { kind: 'project', relPath: 'public/hero.png', src: '/hero.png', buildSafe: true, width: null, height: null },
    ])
  })
})

describe('UnusedImagesFooter — the explicit delete (IMG-11)', () => {
  it('offers nothing when nothing is unused', async () => {
    renderSection()
    await waitFor(() => expect(screen.getAllByTestId('assets-image-card')).toHaveLength(3))
    expect(screen.queryByTestId('assets-unused-images')).toBeNull()
  })

  it('names the count, and deletes nothing until the confirmation is accepted — then exactly those paths', async () => {
    unused = ['public/old-1.png', 'public/old-2.png']
    renderSection()
    await waitFor(() => expect(screen.getByTestId('assets-unused-images')).toBeDefined())
    expect(screen.getByTestId('assets-unused-images').textContent).toContain('2 unused images Studio added')

    fireEvent.click(screen.getByRole('button', { name: 'Delete unused…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete 2 unused images?' })
    expect(dialog.textContent).toContain('old-1.png, old-2.png')
    expect(pruned).toEqual([])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete 2 images' }))
    })
    await waitFor(() => expect(pruned).toEqual([['public/old-1.png', 'public/old-2.png']]))
  })

  it('cancelling deletes nothing', async () => {
    unused = ['public/old-1.png']
    renderSection()
    await waitFor(() => expect(screen.getByTestId('assets-unused-images')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Delete unused…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(pruned).toEqual([])
  })
})
