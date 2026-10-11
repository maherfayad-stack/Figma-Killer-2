/**
 * VectorSection — an inline `<svg>`'s paint in the inspector (owner report:
 * "in svg I can't control the fill"). Mounted against the store like every
 * manifest section; the write is asserted on the `/save` body it posts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { VectorSection } from '../VectorSection'
import { INSPECTOR_SECTIONS } from '../index'
import { BURST_SETTLE_MS } from '../vectorPaintCommit'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const SVG_ID = 'pages/Home.tsx:6:8'
const ROOT_ID = 'root'
const ICON =
  '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2">' +
  '<path data-studio-svg-part="7:10" d="M4 4h16v16H4z"/>' +
  '<circle data-studio-svg-part="8:10" cx="12" cy="12" r="4" fill="red"/>' +
  '</svg>'

let posted: Record<string, unknown>[][]
let realFetch: typeof globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

beforeEach(() => {
  localStorage.clear()
  resetStructuralCommitQueue()
  __resetToastBusForTests()
  posted = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.includes('/studio/save')) {
      posted.push(body.edits ?? [])
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'], createdNodeIds: [], removed: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
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

function selectSvg(props: Record<string, unknown> = { svg: ICON, tag: '' }, extra: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'home',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [SVG_ID] }),
      [SVG_ID]: makeNode({ id: SVG_ID, moduleId: 'base.svg', props, ...extra }),
    },
  })
  useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'home', selectedNodeId: SVG_ID, selectedNodeIds: [SVG_ID] } as Parameters<
    typeof useEditorStore.setState
  >[0])
}

const settle = (ms = BURST_SETTLE_MS + 100) => new Promise((resolve) => setTimeout(resolve, ms))

describe('VectorSection', () => {
  it('is in the manifest, directly above the CSS Fill section', () => {
    const ids = [...INSPECTOR_SECTIONS].sort((a, b) => a.order - b.order).map((section) => section.id)
    expect(ids.indexOf('vector')).toBe(ids.indexOf('fill') - 1)
  })

  it('renders nothing for a node that is not an inline <svg>', () => {
    selectSvg()
    useEditorStore.setState((state) => {
      state.site!.pages[0]!.nodes[SVG_ID]!.moduleId = 'base.div'
    })
    const { container } = render(<VectorSection />)
    expect(container.textContent).toBe('')
  })

  it('shows the whole graphic’s paint: Mixed fill (the shapes differ), the shared black stroke and weight', async () => {
    selectSvg()
    render(<VectorSection />)
    await screen.findByTestId('vector-paint') // the controls load behind a lazy boundary
    expect((screen.getByRole('combobox', { name: 'Stroke type' }) as HTMLInputElement).value).toBe('Colour')
    expect((screen.getByRole('textbox', { name: 'Stroke colour' }) as HTMLInputElement).value).toBe('black')
    expect((screen.getByRole('textbox', { name: 'Fill colour' }) as HTMLInputElement).placeholder).toBe('Mixed')
    expect((screen.getByLabelText('Stroke weight') as HTMLInputElement).value).toBe('2')
  })

  it('a colour typed and committed is ONE save: the root’s fill set, the circle’s own fill removed', async () => {
    selectSvg()
    render(<VectorSection />)
    await screen.findByTestId('vector-paint') // the controls load behind a lazy boundary
    const input = screen.getByRole('textbox', { name: 'Fill colour' })
    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '#ff0000' } })
    fireEvent.blur(input)
    expect(posted).toEqual([])
    await settle()
    // Two commits inside one burst: one save, carrying the LAST colour.
    expect(posted).toHaveLength(1)
    expect(posted[0]).toHaveLength(2)
    expect(posted[0]).toEqual(
      expect.arrayContaining([
        { kind: 'svg-attr', nodeId: SVG_ID, part: '', partTag: 'svg', set: { fill: '#ff0000' } },
        { kind: 'svg-attr', nodeId: SVG_ID, part: '8:10', partTag: 'circle', set: {}, remove: ['fill'] },
      ]),
    )
  })

  it('a burst that ends where it started posts nothing', async () => {
    selectSvg()
    render(<VectorSection />)
    await screen.findByTestId('vector-paint') // the controls load behind a lazy boundary
    const input = screen.getByRole('textbox', { name: 'Stroke colour' })
    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'black' } })
    fireEvent.blur(input)
    await settle()
    expect(posted).toEqual([])
  })

  it('an icon whose markup comes from an .svg file says why nothing here can be written', async () => {
    selectSvg({ svg: ICON, tag: 'span' })
    render(<VectorSection />)
    await screen.findByTestId('vector-paint') // the controls load behind a lazy boundary
    expect(screen.getByTestId('vector-paint-refusal').textContent).toContain('comes from an .svg file')
    expect((screen.getByRole('textbox', { name: 'Stroke colour' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('a locked graphic names its lock', async () => {
    selectSvg({ svg: ICON, tag: '' }, { locked: true, lockReason: 'Built from a spread.' })
    render(<VectorSection />)
    await screen.findByTestId('vector-paint') // the controls load behind a lazy boundary
    expect(screen.getByTestId('vector-paint-refusal').textContent).toBe('This graphic is locked: Built from a spread.')
  })
})
