/**
 * Image fill, end to end through the panel (docs/features/inspector-disclosure.md §4 G6.5).
 *
 * The one thing worth asserting at this level: picking a project image writes
 * a `background-image` layer whose URL is the one the USER'S build resolves —
 * not Studio's own `/admin/api/studio/asset` preview URL, which is what the
 * grid renders its thumbnails from. Confusing the two would paste an
 * admin-origin URL into the user's stylesheet.
 *
 * The project asset list is mocked, so this test never touches the network or
 * a real workspace; `projectAssets.test.ts` covers the real directory walk.
 *
 * Mounts the real `<FillSection />` against the store, same as
 * `fillSection.test.tsx` — kept as its OWN file (not folded into that suite)
 * so its `mock.module` of `studio/projectAssets` stays scoped to exactly the
 * tests that need it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'

const ASSETS = ['public/hero.png', 'src/assets/EN-2.png']

// `mock.module` is process-wide and PERMANENT — `mock.restore()` does not undo
// it, and `bun test --parallel=4` gives each worker a process, not a file, so
// "scoped to exactly the tests that need it" only holds with the `afterAll`
// restore below. Snapshot the real namespace as a plain object BEFORE mocking
// (the namespace object itself is live and gets rewritten). Gated by
// `mock-module-must-restore.test.ts`.
const realProjectAssets = { ...(await import('../../../studio/projectAssets')) }

mock.module('../../../studio/projectAssets', () => ({
  ...realProjectAssets,
  fetchProjectImageAssets: () => Promise.resolve(ASSETS),
  invalidateProjectImageAssets: () => {},
  studioAssetPreviewUrl: (relPath: string) => `/admin/api/studio/asset?path=${relPath}`,
  useProjectImageAssets: () => ASSETS,
  imageFillPreviewSrc: (cssUrl: string) => `/admin/api/studio/asset?url=${cssUrl}`,
}))

afterAll(() => {
  mock.module('../../../studio/projectAssets', () => realProjectAssets)
})

const { FillSection } = await import('../FillSection')
const { makeSite, makePage, makeNode } = await import('../../../../../../__tests__/fixtures')
await import('@modules/base/index')

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectNode(overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', ...overrides }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function currentNode() {
  return useEditorStore.getState().site?.pages[0]?.nodes[NODE_ID]
}

describe('Fill — add an image fill', () => {
  it('opens a source picker instead of writing a speculative empty layer', () => {
    selectNode()
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))

    expect(screen.getByRole('group', { name: 'Image source' })).toBeTruthy()
    expect(currentNode()?.inlineStyles?.backgroundImage).toBeUndefined()
  })

  it("writes the URL the project's build resolves, not the admin preview URL", () => {
    selectNode()
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/ }))

    const written = currentNode()?.inlineStyles?.backgroundImage
    expect(written).toBe("url('/hero.png')")
    expect(String(written)).not.toContain('/admin/api/studio/asset')
  })

  it('inserts the image ABOVE an existing gradient — first layer paints topmost', () => {
    const gradient = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)'
    selectNode({ inlineStyles: { backgroundImage: gradient } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/ }))

    expect(currentNode()?.inlineStyles?.backgroundImage).toBe(`url('/hero.png'), ${gradient}`)
  })

  it('refuses to add a layer when the layer list itself was refused', () => {
    selectNode({ inlineStyles: { backgroundImage: 'var(--layers)' } })
    render(<FillSection />)
    expect(screen.getByRole('button', { name: 'Add image fill' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('warns on an asset outside the public root instead of silently writing a dev-only URL', () => {
    selectNode()
    render(<FillSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Add image fill' }))

    const bundled = screen.getByRole('button', { name: /EN-2\.png/ })
    expect(bundled.textContent).toContain('dev only')
  })
})
