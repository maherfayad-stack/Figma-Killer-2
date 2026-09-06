/**
 * studio_page_diagnostics — the browser leg.
 *
 * The assertions that matter are the ones a screenshot could not answer, and
 * the one a naive implementation gets wrong: a page nobody was watching must
 * NOT come back looking clean. That distinction is the whole point — an agent
 * that reads "no findings" off an unmounted frame concludes the screen is fine
 * and goes back to editing CSS, which is the exact loop this tool exists to
 * break.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { runStudioPageDiagnostics } from './studioPageDiagnostics'
import {
  ensureFrameDiagnostics,
  recordFrameDiagnostic,
} from '../canvas/canvasDiagnosticsBuffer'

const PAGE_ID = 'checkout'

interface PageResult {
  pageId: string
  status: string
  findings?: Array<{ code: string; message: string; count: number; nodeId?: string }>
  truncated?: number
  note?: string
}

/** The frame shape `findAgentRenderFrame` looks for, with a real iframe — the runtime lives in the iframe's window, not the host. */
function mountFrame(pageId = PAGE_ID): Window {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-page-id', pageId)
  const viewport = document.createElement('div')
  viewport.setAttribute('data-breakpoint-id', 'studio')
  const iframe = document.createElement('iframe')
  viewport.appendChild(iframe)
  wrapper.appendChild(viewport)
  document.body.appendChild(wrapper)
  const view = iframe.contentWindow
  if (!view) throw new Error('test environment produced no iframe contentWindow')
  return view as unknown as Window
}

function pagesOf(result: { data?: unknown }): PageResult[] {
  return (result.data as { pages: PageResult[] }).pages
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('runStudioPageDiagnostics', () => {
  it('reports a page with no live frame as no-frame, never as clean', () => {
    const result = runStudioPageDiagnostics({ pageIds: ['not-mounted'] })
    expect(result.ok).toBe(true)
    const page = pagesOf(result)[0]!
    expect(page.status).toBe('no-frame')
    expect(page.findings).toBeUndefined()
    // The message has to say what to DO, not just that something is absent.
    expect(page.note).toContain('NOT a clean result')
  })

  it('reports a mounted frame with no collector as no-collector, also not clean', () => {
    mountFrame()
    const result = runStudioPageDiagnostics({ pageIds: [PAGE_ID] })
    expect(pagesOf(result)[0]!.status).toBe('no-collector')
  })

  it('returns what the frame collected, with a count per distinct problem', () => {
    const view = mountFrame()
    ensureFrameDiagnostics(view)
    for (let i = 0; i < 3; i += 1) {
      recordFrameDiagnostic(view, {
        kind: 'uncaughtError',
        code: 'runtime-uncaught-error',
        message: "TypeError: Cannot read properties of undefined (reading 'map')",
      })
    }
    recordFrameDiagnostic(view, {
      kind: 'resource',
      code: 'asset-load-failed',
      message: '<img> failed to load /hero.png',
      url: '/hero.png',
      nodeId: 'pages/Checkout.tsx:42:7',
    })

    const page = pagesOf(runStudioPageDiagnostics({ pageIds: [PAGE_ID] }))[0]!
    expect(page.status).toBe('ok')
    const thrown = page.findings?.find((f) => f.code === 'runtime-uncaught-error')
    // Three occurrences collapse to ONE finding carrying the number.
    expect(thrown?.count).toBe(3)
    expect(page.findings).toHaveLength(2)
    // The node id survives to the server leg, which decodes it to file:line.
    expect(page.findings?.find((f) => f.code === 'asset-load-failed')?.nodeId).toBe('pages/Checkout.tsx:42:7')
  })

  it('puts errors ahead of warnings so the top of the list is the thing to fix', () => {
    const view = mountFrame()
    ensureFrameDiagnostics(view)
    recordFrameDiagnostic(view, { kind: 'consoleError', code: 'runtime-console-error', message: 'Warning: each child needs a key' })
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'ReferenceError: cart is not defined' })

    const findings = pagesOf(runStudioPageDiagnostics({ pageIds: [PAGE_ID] }))[0]!.findings
    expect(findings?.[0]?.code).toBe('runtime-uncaught-error')
  })

  it('caps findings per page and reports the overflow as a number', () => {
    const view = mountFrame()
    ensureFrameDiagnostics(view)
    for (let i = 0; i < 5; i += 1) {
      recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: `error ${i}` })
    }
    const page = pagesOf(runStudioPageDiagnostics({ pageIds: [PAGE_ID], limit: 2 }))[0]!
    expect(page.findings).toHaveLength(2)
    expect(page.truncated).toBe(3)
  })

  it('answers for every requested page in one call', () => {
    const view = mountFrame()
    ensureFrameDiagnostics(view)
    const pages = pagesOf(runStudioPageDiagnostics({ pageIds: [PAGE_ID, 'other'] }))
    expect(pages.map((p) => p.pageId)).toEqual([PAGE_ID, 'other'])
    expect(pages[1]!.status).toBe('no-frame')
  })
})
