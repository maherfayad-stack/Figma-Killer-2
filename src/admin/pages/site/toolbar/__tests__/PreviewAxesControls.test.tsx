/**
 * PreviewAxesControls.test.tsx — WS-10 §7.4 "probe honesty": the dark-mode
 * toggle and the locale `Select` both render DISABLED WITH THE REASON when
 * the project has no detectable mechanism/dictionary, and become interactive
 * once the probe finds one. Direction has no such gate — it always applies.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_PREVIEW_AXES } from '@core/studio-board'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { clearPreviewCapabilities, refreshPreviewCapabilities } from '@site/studio/previewAxesCapability'
import { PreviewAxesControls } from '../PreviewAxesControls'

const originalFetch = globalThis.fetch

function mockProbeFetch(
  colorScheme: { mechanism: 'media' | 'class' | 'none'; selector?: string },
  locales?: { keys: string[]; defaultKey?: string; source: string },
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/admin/api/studio/probe')
      ? { profile: { colorScheme, ...(locales ? { locales } : {}) } }
      : { ok: true, previewAxes: DEFAULT_PREVIEW_AXES }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeEach(() => {
  cleanup()
  clearPreviewCapabilities()
  useEditorStore.setState({ previewAxes: DEFAULT_PREVIEW_AXES } as Parameters<typeof useEditorStore.setState>[0])
  useAdminUi.setState({ studioProject: { dir: '/tmp/fixture-project', name: 'fixture' } })
})

afterEach(() => {
  cleanup()
  clearPreviewCapabilities()
  globalThis.fetch = originalFetch
  useAdminUi.setState({ studioProject: null })
})

describe('PreviewAxesControls', () => {
  it('renders the dark-mode toggle disabled with the probe reason when no mechanism is detected', async () => {
    mockProbeFetch({ mechanism: 'none' })
    render(<PreviewAxesControls />)
    await act(async () => {
      await refreshPreviewCapabilities('/tmp/fixture-project')
    })

    const schemeButton = await screen.findByRole('button', { name: /preview color scheme/i })
    expect(schemeButton.getAttribute('aria-disabled')).toBe('true')
    expect(schemeButton.getAttribute('aria-label')).toContain('No dark-mode stylesheet was detected')
  })

  it('enables the dark-mode toggle once the probe detects a mechanism', async () => {
    mockProbeFetch({ mechanism: 'class', selector: '.dark' })
    render(<PreviewAxesControls />)
    await act(async () => {
      await refreshPreviewCapabilities('/tmp/fixture-project')
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

  // WS-10 §4.2 (Phase 3) — locale is parse-time, so switching it must trigger
  // a reload (`CMS_SITE_RELOAD_EVENT`), unlike direction/colorScheme.
  describe('locale', () => {
    it('renders the locale control disabled with the probe reason when no dictionary is detected', async () => {
      mockProbeFetch({ mechanism: 'none' })
      render(<PreviewAxesControls />)
      await act(async () => {
        await refreshPreviewCapabilities('/tmp/fixture-project')
      })

      const trigger = await screen.findByTestId('toolbar-preview-locale')
      expect(trigger.getAttribute('disabled')).not.toBeNull()
      expect(trigger.getAttribute('aria-label')).toContain('No locale dictionary was detected')
    })

    it('enables the locale control once the probe detects a dictionary, defaulting to defaultKey', async () => {
      mockProbeFetch({ mechanism: 'none' }, { keys: ['en', 'ar'], defaultKey: 'en', source: 'src/i18n/translations.js' })
      render(<PreviewAxesControls />)
      await act(async () => {
        await refreshPreviewCapabilities('/tmp/fixture-project')
      })

      const trigger = await screen.findByTestId('toolbar-preview-locale') as HTMLInputElement
      await waitFor(() => expect(trigger.disabled).toBe(false))
      expect(trigger.value).toBe('EN')
    })

    it('choosing a locale persists it, updates the store, and requests a site reload', async () => {
      mockProbeFetch({ mechanism: 'none' }, { keys: ['en', 'ar'], defaultKey: 'en', source: 'src/i18n/translations.js' })
      render(<PreviewAxesControls />)
      await act(async () => {
        await refreshPreviewCapabilities('/tmp/fixture-project')
      })

      let reloadFired = false
      const onReload = () => { reloadFired = true }
      window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      try {
        const trigger = await screen.findByTestId('toolbar-preview-locale') as HTMLInputElement
        await waitFor(() => expect(trigger.disabled).toBe(false))

        // Same open/select pattern `select.test.tsx` uses: click the chevron
        // (the trigger's next sibling) to open, then the option BUTTON
        // itself (by role/name, not its inner text node) to commit.
        fireEvent.click(trigger.nextElementSibling as HTMLElement)
        fireEvent.click(screen.getByRole('option', { name: 'AR' }))

        expect(useEditorStore.getState().previewAxes.locale).toBe('ar')
        await waitFor(() => expect(reloadFired).toBe(true))
      } finally {
        window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      }
    })
  })
})
