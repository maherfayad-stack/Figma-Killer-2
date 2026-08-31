/**
 * ContentPanel — the bilingual dictionary editor.
 *
 * What matters here is that the panel tells the truth about three distinct
 * situations, because they look identical if you only render an array:
 * a project with no locale mechanism at all, a key with no Arabic yet, and a
 * write the server refuses. The first must not look like an empty table, the
 * second is the state the whole panel exists to fix, and the third must never
 * be swallowed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContentPanel } from '@site/panels/ContentPanel'
import { ToastProvider } from '@ui/components/Toast'

const originalFetch = globalThis.fetch

const CATALOG = {
  capability: { keys: ['en', 'ar'], defaultKey: 'en', source: 'src/i18n/translations.js' },
  perLocaleFiles: false,
  entries: [
    { key: 'greeting', values: { en: 'Hello', ar: 'مرحبا' } },
    { key: 'nav.home', values: { en: 'Home' } },
  ],
}

/** Stubs the content GET and records every write POST. `setupResponse` answers the i18n-setup action. */
function stubApi(
  catalog: unknown,
  hardcoded: unknown[] = [],
  writeResponse: unknown = { ok: true },
  setupResponse: unknown = { ok: true, source: 'i18n/translations.ts', locales: ['en', 'ar'], extracted: 2, filesChanged: 1, failures: [] },
) {
  const writes: Record<string, unknown>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/i18n-setup')) {
      writes.push({ setup: true })
      return new Response(JSON.stringify(setupResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/admin/api/studio/translations')) {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(JSON.stringify(writeResponse), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ catalog, hardcoded }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return writes
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('ContentPanel', () => {
  it('maps every dictionary key to a row, one input per declared locale', async () => {
    stubApi(CATALOG)
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByText('greeting')).toBeTruthy())
    // Nested keys are addressable rows, not dropped.
    expect(screen.getByText('nav.home')).toBeTruthy()
    expect((screen.getAllByLabelText('en value')[0] as HTMLInputElement).value).toBe('Hello')
    expect((screen.getAllByLabelText('ar value')[0] as HTMLInputElement).value).toBe('مرحبا')
  })

  it('renders an Arabic cell as empty — not missing — when the key has no translation yet', async () => {
    stubApi(CATALOG)
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByText('nav.home')).toBeTruthy())
    // Two rows, so two Arabic inputs; the second one is the untranslated key.
    const arabic = screen.getAllByLabelText('ar value') as HTMLInputElement[]
    expect(arabic).toHaveLength(2)
    expect(arabic[1]!.value).toBe('')
  })

  it('lists the inline copy when setting a dictionary up was refused', async () => {
    // A project with hardcoded strings HAS content — it just has nowhere to
    // translate it to. Showing nothing would be the opposite of the truth.
    stubApi(null, [
      { file: 'pages/Page.tsx', line: 28, col: 11, prop: 'title', text: 'Profile verified' },
      { file: 'pages/Page.tsx', line: 37, col: 9, prop: null, text: 'Add your text here.' },
    ])
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByTestId('content-panel-hardcoded')).toBeTruthy())
    expect(screen.getByText('Profile verified')).toBeTruthy()
    expect(screen.getByText('Add your text here.')).toBeTruthy()
    // Read-only: no input, because there is nowhere to write a translation.
    expect(screen.queryByLabelText('ar value')).toBeNull()
  })

  it('writes one entry on blur, naming the locale and the key', async () => {
    const writes = stubApi(CATALOG)
    const user = userEvent.setup()
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByText('nav.home')).toBeTruthy())
    const arabic = screen.getAllByLabelText('ar value') as HTMLInputElement[]
    await user.click(arabic[1]!)
    await user.paste('الرئيسية')
    await user.tab()

    await waitFor(() => expect(writes.length).toBeGreaterThan(0))
    expect(writes[0]).toMatchObject({ locale: 'ar', key: 'nav.home', value: 'الرئيسية' })
  })

  it('does not write when the value was not edited', async () => {
    const writes = stubApi(CATALOG)
    const user = userEvent.setup()
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByText('greeting')).toBeTruthy())
    await user.click(screen.getAllByLabelText('ar value')[0]!)
    await user.tab()

    expect(writes).toHaveLength(0)
  })

  it('sets locales up on its own when the project has none — opening the panel is the request', async () => {
    const calls = stubApi(null, [
      { file: 'pages/Page.tsx', line: 28, col: 11, prop: 'title', text: 'Profile verified' },
    ])
    render(<ContentPanel />)

    // No click: a project with copy and no dictionary gets one.
    await waitFor(() => expect(calls.some((call) => call.setup === true)).toBe(true))
  })

  it('does not run setup again after it was refused once', async () => {
    const calls = stubApi(null, [{ file: 'pages/Page.tsx', line: 1, col: 1, prop: 'title', text: 'Profile verified' }], { ok: true }, {
      ok: false,
      message: 'This project already has a locale dictionary.',
    })
    render(<ContentPanel />)

    // A source rewrite must not retry itself on every render.
    await waitFor(() => expect(screen.getByTestId('content-panel-setup')).toBeTruthy())
    expect(calls.filter((call) => call.setup === true)).toHaveLength(1)
  })

  it('surfaces a refusal to set up rather than reporting success', async () => {
    stubApi(null, [{ file: 'pages/Page.tsx', line: 1, col: 1, prop: 'title', text: 'Profile verified' }], { ok: true }, {
      ok: false,
      message: 'This project already has a locale dictionary.',
    })
    // A refusal reaches the user through the global toast bus, so the provider
    // is mounted here — asserting on the bus directly would pass even if the
    // message never rendered.
    render(
      <>
        <ContentPanel />
        <ToastProvider />
      </>,
    )

    await waitFor(() => expect(screen.getAllByText('This project already has a locale dictionary.').length).toBeGreaterThan(0))
  })

  it('shows strings that are still in the code even once a dictionary exists', async () => {
    // The bug: `hardcoded` was rendered ONLY in the no-dictionary state, so
    // the moment a dictionary existed the still-inline strings were in the
    // payload and absent from the UI.
    stubApi(CATALOG, [{ file: 'pages/Home.tsx', line: 39, col: 20, prop: 'value', text: 'Dubai (DXB)' }])
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByTestId('content-panel-inline')).toBeTruthy())
    expect(screen.getByText(/1 string still in the code/i)).toBeTruthy()
    // The table is still there — this section must not replace it.
    expect(screen.getByTestId('content-panel-rows')).toBeTruthy()
  })

  it('offers to move those strings into the dictionary that already exists', async () => {
    const calls = stubApi(CATALOG, [{ file: 'pages/Home.tsx', line: 39, col: 20, prop: 'value', text: 'Dubai (DXB)' }])
    const user = userEvent.setup()
    render(<ContentPanel />)

    await waitFor(() => expect(screen.getByTestId('content-panel-extract')).toBeTruthy())
    // Not auto-run here: the project already has a dictionary, so this is an
    // explicit source rewrite the user asks for.
    expect(calls.some((call) => call.setup === true)).toBe(false)

    await user.click(screen.getByTestId('content-panel-extract'))
    await waitFor(() => expect(calls.some((call) => call.setup === true)).toBe(true))
  })
})
