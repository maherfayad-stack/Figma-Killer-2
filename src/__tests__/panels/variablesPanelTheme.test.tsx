/**
 * The Variables panel's Tailwind / JavaScript theme rows (CT-6) through
 * happy-dom: a Tailwind v3 config's values and a `theme.ts` token file listed
 * read-only with the reason, a computed value that says it is computed, "apply
 * by utility class" posting one literal `class` edit for the selection, and a
 * Tailwind v4 `@theme` variable offering the same classes beside its normal
 * edit/rename. The server is a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JsThemeEntry, TokenCatalog } from '@core/studio-tokens'
import { VariablesPanel } from '@site/panels/VariablesPanel'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'

const originalFetch = globalThis.fetch
const NODE = 'src/Menu.tsx:5:7'

function entry(over: Partial<JsThemeEntry> & Pick<JsThemeEntry, 'path' | 'value'>): JsThemeEntry {
  const group = over.group ?? 'colors'
  return {
    id: `tailwind.config.js#${group}.${over.path}`,
    file: 'tailwind.config.js',
    line: 8,
    source: 'tailwind-config',
    group,
    family: 'color',
    raw: over.value === null ? 'colors.sky[500]' : `'${over.value}'`,
    utilities: [],
    readOnlyReason: `Written in tailwind.config.js:8, a JavaScript file Studio reads without running, so it does not change the value from here. Edit it in tailwind.config.js.`,
    ...over,
  }
}

const CATALOG: TokenCatalog = {
  tokens: [
    {
      name: '--color-crust',
      family: 'color',
      collection: 'src/theme.css#color',
      decls: [{ gate: { kind: 'base' }, selector: null, atRules: ['@theme'], value: '#c58940', resolvedValue: '#c58940', file: 'src/theme.css', line: 4, origin: 'project', winning: true, inTheme: true }],
      usage: { count: 2, sites: [{ file: 'src/Menu.tsx', line: 3 }] },
    },
    {
      name: '--brand-glow',
      family: 'other',
      collection: 'src/theme.css#brand',
      decls: [{ gate: { kind: 'base' }, selector: ':root', atRules: [], value: '0 0 8px #fff', resolvedValue: '0 0 8px #fff', file: 'src/theme.css', line: 9, origin: 'project', winning: true, inTheme: false }],
      usage: { count: 0, sites: [] },
    },
  ],
  collections: [
    { id: 'src/theme.css#color', label: 'color', file: 'src/theme.css', origin: 'project', editable: true },
    { id: 'src/theme.css#brand', label: 'brand', file: 'src/theme.css', origin: 'project', editable: true },
  ],
  axes: [],
  jsTheme: [
    entry({ path: 'berry', value: '#8e2a4b', line: 8, utilities: ['bg-berry', 'text-berry', 'border-berry'] }),
    entry({
      path: 'brand',
      value: null,
      line: 9,
      utilities: ['bg-brand', 'text-brand'],
      readOnlyReason: 'Computed in tailwind.config.js:9 (it is loaded with require(), which only running the file can do), so its value is only known by running your code, which Studio never does. Edit it in tailwind.config.js. You can still apply it to an element with a class such as bg-brand.',
    }),
    entry({
      id: 'src/theme.ts#colors.primary',
      file: 'src/theme.ts',
      source: 'theme-file',
      path: 'primary',
      value: '#0ea5e9',
      line: 2,
      readOnlyReason: 'Written in src/theme.ts:2. No Tailwind config in this project reads that file, so Studio has no class that applies it, and it does not run code to rewrite it. Edit it in src/theme.ts, or declare it as a CSS variable.',
    }),
  ],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let saved: Array<Record<string, unknown>[]>

function stubServer(options: { refuse?: boolean } = {}): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/studio/save')) {
      const body = JSON.parse(String(init?.body)) as { edits: Record<string, unknown>[] }
      saved.push(body.edits)
      if (options.refuse) {
        return json({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: [], refusals: [{ nodeId: NODE, kind: 'class', reason: 'unsupported-expression', message: 'the className is a number' }] })
      }
      return json({ ok: true, written: body.edits.length, skipped: 0, shifted: false, sharedComponents: false, undoToken: '0123456789abcdef0123456789abcdef', touchedFiles: ['src/Menu.tsx'] })
    }
    if (url.includes('/token-catalog') && init?.method === 'POST') {
      return json({ ok: true, files: [{ path: 'src/theme.css', hash: 'h' }], inserted: [], renamed: [{ name: '--color-crust', to: '--color-toast', mentions: 4, files: 3, unfollowed: ['src/Menu.tsx:4'] }], removed: [], undoToken: null })
    }
    if (url.includes('/token-catalog')) return json(CATALOG)
    return json({ ok: true, narrow: false })
  }) as typeof fetch
}

beforeEach(() => {
  cleanup()
  resetStructuralCommitQueue()
  saved = []
  useEditorStore.setState({ variablesPanelOpen: true, selectedNodeIds: [], selectedNodeId: null })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  useEditorStore.setState({ variablesPanelOpen: false, selectedNodeIds: [], selectedNodeId: null })
})

/** Opens a row's actions menu and picks an item. */
function chooseRowAction(token: string, item: string): void {
  fireEvent.click(screen.getByLabelText(`Actions for ${token}`))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

async function renderPanel() {
  render(<VariablesPanel />)
  await screen.findByTestId('theme-entry-tailwind.config.js#colors.berry')
}

describe('VariablesPanel - JavaScript theme rows', () => {
  it('lists each file that defines a theme as a read-only group, with the line each value is written on', async () => {
    stubServer()
    await renderPanel()
    expect(screen.getByRole('region', { name: 'JavaScript theme tailwind.config.js' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'JavaScript theme src/theme.ts' })).toBeTruthy()
    const berry = screen.getByTestId('theme-entry-tailwind.config.js#colors.berry')
    expect(berry.textContent).toContain('colors.berry')
    expect(berry.textContent).toContain('#8e2a4b')
    expect(berry.textContent).toContain('tailwind.config.js:8')
    // A value that is text, not an input that pretends to be editable.
    expect(berry.querySelector('input')).toBeNull()
  })

  it('shows a computed value as what is written, and says why it has no value', async () => {
    stubServer()
    await renderPanel()
    const brand = screen.getByTestId('theme-entry-tailwind.config.js#colors.brand')
    expect(brand.textContent).toContain('colors.sky[500]')
    fireEvent.click(screen.getByLabelText('Why colors.brand is read-only'))
    expect(brand.textContent).toContain('which Studio never does')
    expect(brand.textContent).toContain('Edit it in tailwind.config.js')
  })

  it('"Why" gives the sentence that says what to do instead', async () => {
    stubServer()
    await renderPanel()
    fireEvent.click(screen.getByLabelText('Why colors.berry is read-only'))
    expect(screen.getByTestId('theme-entry-tailwind.config.js#colors.berry').textContent).toContain('so it does not change the value from here. Edit it in tailwind.config.js.')
  })

  it('offers no class to apply for a token file no Tailwind config reads, and says why in its reason', async () => {
    stubServer()
    await renderPanel()
    expect(screen.queryByLabelText('Apply colors.primary as a class')).toBeNull()
    fireEvent.click(screen.getByLabelText('Why colors.primary is read-only'))
    expect(screen.getByTestId('theme-entry-src/theme.ts#colors.primary').textContent).toContain('No Tailwind config in this project reads that file')
  })

  it('searches the theme rows by name, value and class', async () => {
    stubServer()
    await renderPanel()
    fireEvent.change(screen.getByLabelText('Search variables'), { target: { value: 'bg-berry' } })
    expect(screen.queryByTestId('theme-entry-tailwind.config.js#colors.brand')).toBeNull()
    expect(screen.getByTestId('theme-entry-tailwind.config.js#colors.berry')).toBeTruthy()
  })
})

describe('VariablesPanel - apply by utility class', () => {
  it('tells you to select something first, and writes nothing', async () => {
    stubServer()
    await renderPanel()
    fireEvent.click(screen.getByLabelText('Apply colors.berry as a class'))
    expect(screen.getByText('Select an element on the board first.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'bg-berry' }) as HTMLButtonElement).disabled).toBe(true)
    expect(saved).toHaveLength(0)
  })

  it('posts ONE literal class edit, marked restyle (journaled), for the selected element', async () => {
    stubServer()
    useEditorStore.setState({ selectedNodeIds: [NODE], selectedNodeId: NODE })
    await renderPanel()
    fireEvent.click(screen.getByLabelText('Apply colors.berry as a class'))
    fireEvent.click(screen.getByRole('button', { name: 'bg-berry' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject([{ kind: 'class', nodeId: NODE, add: [{ kind: 'literal', token: 'bg-berry' }], remove: [], restyle: true }])
  })

  it('a refusal is the engine warning, never an Added message', async () => {
    stubServer({ refuse: true })
    useEditorStore.setState({ selectedNodeIds: [NODE], selectedNodeId: NODE })
    await renderPanel()
    fireEvent.click(screen.getByLabelText('Apply colors.berry as a class'))
    fireEvent.click(screen.getByRole('button', { name: 'text-berry' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(screen.queryByText(/Added text-berry/)).toBeNull()
  })

  it('a Tailwind v4 @theme variable offers its classes beside edit and rename', async () => {
    stubServer()
    useEditorStore.setState({ selectedNodeIds: [NODE], selectedNodeId: NODE })
    await renderPanel()
    chooseRowAction('--color-crust', 'Apply as a class')
    for (const className of ['bg-crust', 'text-crust', 'border-crust']) expect(screen.getByRole('button', { name: className })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'text-crust' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject([{ kind: 'class', add: [{ kind: 'literal', token: 'text-crust' }] }])
    expect(screen.getByLabelText('Actions for --color-crust')).toBeTruthy()
  })

  it('a variable outside any Tailwind namespace has no class to apply', async () => {
    stubServer()
    await renderPanel()
    expect(screen.queryByLabelText('Apply --brand-glow as a class')).toBeNull()
  })

  it('a rename says which classes built in code it could not follow, beside the Undo', async () => {
    stubServer()
    await renderPanel()
    chooseRowAction('--color-crust', 'Rename')
    const input = screen.getByLabelText('New name for --color-crust')
    fireEvent.change(input, { target: { value: '--color-toast' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Renamed --color-crust to --color-toast - 4 places updated.')
    expect(status.textContent).toContain('Classes built in code at src/Menu.tsx:4 were not changed - check them.')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})
