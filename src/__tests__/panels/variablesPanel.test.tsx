/**
 * The Variables panel (CT-3) through happy-dom: what it lists, the edit
 * contract (type = preview only, commit = ONE write, Escape = nothing), rename
 * and remove (with and without a replacement), and the rows it will not offer
 * controls on. The server is a stubbed `fetch`; its planner has its own tests.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TokenCatalog } from '@core/studio-tokens'
import { VariablesPanel } from '@site/panels/VariablesPanel'
import { useEditorStore } from '@site/store/store'
import { getStudioTokenPreview, setStudioTokenPreview } from '@site/studio/studioTokenPreview'

const originalFetch = globalThis.fetch
const DARK = { kind: 'attr', attr: 'data-theme', value: 'dark' } as const

function decl(over: Partial<TokenCatalog['tokens'][number]['decls'][number]> & { value: string }): TokenCatalog['tokens'][number]['decls'][number] {
  return {
    gate: { kind: 'base' },
    selector: ':root',
    atRules: [],
    resolvedValue: over.value,
    file: 'src/tokens.css',
    line: 2,
    origin: 'project',
    winning: true,
    inTheme: false,
    ...over,
  }
}

const CATALOG: TokenCatalog = {
  tokens: [
    {
      name: '--color-brand',
      family: 'color',
      collection: 'src/tokens.css#color',
      decls: [decl({ value: '#0c9ab0' }), decl({ value: '#5fd3e4', gate: DARK, selector: "[data-theme='dark']", line: 8 })],
      usage: { count: 3, sites: [{ file: 'src/app.css', line: 4 }] },
    },
    {
      name: '--color-accent',
      family: 'color',
      collection: 'src/tokens.css#color',
      decls: [decl({ value: '#ff0066', line: 3 })],
      usage: { count: 0, sites: [] },
    },
    {
      name: '--status-cutout',
      family: 'other',
      collection: 'src/tokens.css#status',
      decls: [decl({ value: '#000', gate: { kind: 'scope', selector: '.card' }, selector: '.card', file: 'src/Card.module.css', line: 6 })],
      usage: { count: 1, sites: [{ file: 'src/Card.module.css', line: 7 }] },
    },
    {
      name: '--pkg-gap',
      family: 'space',
      collection: '@acme/ui/dist/style.css#pkg',
      decls: [decl({ value: '4px', file: '@acme/ui/dist/style.css', origin: 'package' })],
      usage: { count: 1, sites: [{ file: 'src/app.css', line: 9 }] },
    },
  ],
  collections: [
    { id: 'src/tokens.css#color', label: 'color', file: 'src/tokens.css', origin: 'project', editable: true },
    { id: 'src/tokens.css#status', label: 'status', file: 'src/Card.module.css', origin: 'project', editable: true },
    { id: '@acme/ui/dist/style.css#pkg', label: 'pkg', file: '@acme/ui/dist/style.css', origin: 'package', editable: false },
  ],
  axes: [{ id: 'color-scheme', label: 'Color scheme', modes: [{ id: 'dark', label: 'Dark', gate: DARK }] }],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Posted {
  edits: Array<Record<string, unknown>>
}

function stubServer(options: { refuse?: { status: number; body: unknown } } = {}): Posted[] {
  const posted: Posted[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/token-catalog') && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as Posted)
      if (options.refuse) return json(options.refuse.body, options.refuse.status)
      return json({ ok: true, files: [{ path: 'src/tokens.css', hash: 'h' }], inserted: [], renamed: [{ name: '--color-accent', to: '--color-pop', mentions: 2, files: 1, unfollowed: [] }], removed: [], undoToken: null })
    }
    if (url.includes('/token-catalog')) return json(CATALOG)
    if (url.includes('/reload-scope')) return json({ ok: true, narrow: false })
    return json({})
  }) as typeof fetch
  return posted
}

beforeEach(() => {
  cleanup()
  useEditorStore.setState({ variablesPanelOpen: true })
})

afterEach(() => {
  cleanup()
  setStudioTokenPreview(null)
  globalThis.fetch = originalFetch
  useEditorStore.setState({ variablesPanelOpen: false })
})

/** Opens a row's actions menu and picks an item - the row has no inline buttons any more. */
function chooseRowAction(token: string, item: 'Rename' | 'Remove'): void {
  fireEvent.click(screen.getByLabelText(`Actions for ${token}`))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

async function renderPanel() {
  render(<VariablesPanel />)
  await screen.findByTestId('variable-row---color-brand')
}

describe('VariablesPanel', () => {
  it('lists collections, a column per mode, values and usage counts', async () => {
    stubServer()
    await renderPanel()
    expect(screen.getByRole('region', { name: 'color' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'pkg' })).toBeTruthy()
    expect((screen.getByLabelText('--color-brand Default') as HTMLInputElement).value).toBe('#0c9ab0')
    expect((screen.getByLabelText('--color-brand Dark') as HTMLInputElement).value).toBe('#5fd3e4')
    expect(screen.getByTestId('variable-row---color-brand').textContent).toContain('3 uses')
    expect(screen.getByTestId('variable-row---color-accent').textContent).toContain('unused')
  })

  it('previews while typing, then commits ONE write on blur and clears the preview', async () => {
    const posted = stubServer()
    await renderPanel()
    const dark = screen.getByLabelText('--color-brand Dark') as HTMLInputElement
    fireEvent.change(dark, { target: { value: '#112233' } })
    expect(getStudioTokenPreview()).toMatchObject({ name: '--color-brand', value: '#112233', selector: "[data-theme='dark']", atRules: [] })
    expect(posted).toHaveLength(0)

    fireEvent.blur(dark)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([{ op: 'set', name: '--color-brand', value: '#112233', target: DARK }])
    await waitFor(() => expect(getStudioTokenPreview()).toBeNull())
  })

  it('shows a token declared inside a rule with its value and selector, and writes it to that scope', async () => {
    const posted = stubServer()
    await renderPanel()
    const field = screen.getByLabelText('--status-cutout in .card') as HTMLInputElement
    expect(field.value).toBe('#000')
    expect((screen.getByLabelText('--status-cutout Default') as HTMLInputElement).value).toBe('')
    fireEvent.change(field, { target: { value: '#111111' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([{ op: 'set', name: '--status-cutout', value: '#111111', target: { kind: 'scope', selector: '.card' } }])
  })

  it('a refused write is shown in the row it came from', async () => {
    stubServer({ refuse: { status: 422, body: { error: 'The project has no global stylesheet to declare a token in.', code: 'no-project-stylesheet', entryIndex: 0 } } })
    await renderPanel()
    const field = screen.getByLabelText('--status-cutout Default')
    fireEvent.change(field, { target: { value: '#111111' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    const alert = await screen.findByRole('alert')
    expect(screen.getByTestId('variable-row---status-cutout').contains(alert)).toBe(true)
  })

  it('Escape cancels: no write, no preview', async () => {
    const posted = stubServer()
    await renderPanel()
    const base = screen.getByLabelText('--color-brand Default')
    fireEvent.change(base, { target: { value: '#000000' } })
    fireEvent.keyDown(base, { key: 'Escape' })
    expect(getStudioTokenPreview()).toBeNull()
    fireEvent.blur(base)
    expect(posted).toHaveLength(0)
  })

  it('a mode with no value declares one with an insert', async () => {
    const posted = stubServer()
    await renderPanel()
    const dark = screen.getByLabelText('--color-accent Dark')
    expect((dark as HTMLInputElement).placeholder).toBe('Inherits default')
    fireEvent.change(dark, { target: { value: '#ff99bb' } })
    fireEvent.keyDown(dark, { key: 'Enter' })
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([{ op: 'insert', name: '--color-accent', value: '#ff99bb', target: DARK }])
  })

  it('renames in one write and says how many places moved', async () => {
    const posted = stubServer()
    await renderPanel()
    chooseRowAction('--color-accent', 'Rename')
    const input = screen.getByLabelText('New name for --color-accent')
    fireEvent.change(input, { target: { value: '--color-pop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([{ op: 'rename', name: '--color-accent', to: '--color-pop' }])
    await screen.findByText('Renamed --color-accent to --color-pop - 2 places updated.')
  })

  it('removes an unused variable directly, and demands a replacement for a used one', async () => {
    const posted = stubServer()
    await renderPanel()

    chooseRowAction('--color-accent', 'Remove')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([{ op: 'remove', name: '--color-accent' }])

    chooseRowAction('--color-brand', 'Remove')
    expect((screen.getByRole('button', { name: 'Replace and remove' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/is used 3 times/)).toBeTruthy()
  })

  it('offers no controls on a package-declared variable, and says why', async () => {
    stubServer()
    await renderPanel()
    const row = screen.getByTestId('variable-row---pkg-gap')
    expect(row.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByLabelText('Actions for --pkg-gap'))
    expect((screen.getByRole('menuitem', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true)
    expect(row.textContent).toContain('Declared outside the project')
  })

  it('shows a refusal next to its row, not as a toast', async () => {
    stubServer({ refuse: { status: 422, body: { error: '--color-pop is already declared at src/tokens.css:9.', code: 'already-declared', entryIndex: 0 } } })
    await renderPanel()
    chooseRowAction('--color-accent', 'Rename')
    const input = screen.getByLabelText('New name for --color-accent')
    fireEvent.change(input, { target: { value: '--color-pop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('already declared')
    expect(screen.getByTestId('variable-row---color-accent').contains(alert)).toBe(true)
  })
})
