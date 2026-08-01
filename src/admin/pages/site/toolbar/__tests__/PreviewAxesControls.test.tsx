/**
 * PreviewAxesControls.test.tsx — WS-10 Phase 1 §7.4 "probe honesty": the
 * dark-mode toggle renders DISABLED WITH THE REASON when the project has no
 * detectable dark-mode mechanism, and becomes interactive once the probe
 * finds one. Direction has no such gate — it always applies.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_PREVIEW_AXES } from '@core/studio-board'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { clearColorSchemeCapability, refreshColorSchemeCapability } from '@site/studio/previewAxesCapability'
import { PreviewAxesControls } from '../PreviewAxesControls'

const originalFetch = globalThis.fetch

function mockProbeFetch(colorScheme: { mechanism: 'media' | 'class' | 'none'; selector?: string }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/admin/api/studio/probe')
      ? { profile: { colorScheme } }
      : { ok: true, previewAxes: DEFAULT_PREVIEW_AXES }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeEach(() => {
  cleanup()
  clearColorSchemeCapability()
  useEditorStore.setState({ previewAxes: DEFAULT_PREVIEW_AXES } as Parameters<typeof useEditorStore.setState>[0])
  useAdminUi.setState({ studioProject: { dir: '/tmp/fixture-project', name: 'fixture' } })
})

afterEach(() => {
  cleanup()
  clearColorSchemeCapability()
  globalThis.fetch = originalFetch
  useAdminUi.setState({ studioProject: null })
})

describe('PreviewAxesControls', () => {
  it('renders the dark-mode toggle disabled with the probe reason when no mechanism is detected', async () => {
    mockProbeFetch({ mechanism: 'none' })
    render(<PreviewAxesControls />)
    await act(async () => {
      await refreshColorSchemeCapability('/tmp/fixture-project')
    })

    const schemeButton = await screen.findByRole('button', { name: /preview color scheme/i })
    expect(schemeButton.getAttribute('aria-disabled')).toBe('true')
    expect(schemeButton.getAttribute('aria-label')).toContain('No dark-mode stylesheet was detected')
  })

  it('enables the dark-mode toggle once the probe detects a mechanism', async () => {
    mockProbeFetch({ mechanism: 'class', selector: '.dark' })
    render(<PreviewAxesControls />)
    await act(async () => {
      await refreshColorSchemeCapability('/tmp/fixture-project')
    })

    const schemeButton = await screen.findByRole('button', { name: /preview color scheme/i })
    await waitFor(() => expect(schemeButton.getAttribute('aria-disabled')).toBeNull())
  })

  it('clicking the direction toggle flips previewAxes.direction, with no probe gate at all', async () => {
    mockProbeFetch({ mechanism: 'none' })
    render(<PreviewAxesControls />)

    const dirButton = screen.getByRole('button', { name: /preview direction/i })
    expect(dirButton.getAttribute('aria-disabled')).toBeNull()
    expect(useEditorStore.getState().previewAxes.direction).toBe('ltr')

    fireEvent.click(dirButton)
    expect(useEditorStore.getState().previewAxes.direction).toBe('rtl')

    fireEvent.click(dirButton)
    expect(useEditorStore.getState().previewAxes.direction).toBe('ltr')
  })
})
