/**
 * CanvasEmptyPageHint — P3-B (WB-5): a page with no nodes is not always an
 * empty page. When the load says its default export could not be read
 * (`unreadable-page-export`), the frame names the shape instead of inviting the
 * user to "add the first element" to a file whose real component it never
 * showed. A warning for ANOTHER page, or a different warning code, changes
 * nothing here.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { CanvasEmptyPageHint } from '../CanvasEmptyPageHint'
import { setStudioLoadWarnings } from '../../studio/studioLoadWarningsStore'

afterEach(() => {
  cleanup()
  setStudioLoadWarnings([])
})

const LAZY_MESSAGE = 'The default export of pages/Later.tsx is a call to lazy(), which Studio would have to run to see what it renders.'

describe('CanvasEmptyPageHint', () => {
  it('says the page is empty when nothing says otherwise', () => {
    const view = render(<CanvasEmptyPageHint pageId="home" />)
    expect(view.getByTestId('canvas-empty-page-hint').textContent).toContain('This page is empty.')
  })

  it('names the unreadable shape for its own page, and only its own', () => {
    setStudioLoadWarnings([
      { code: 'unreadable-page-export', pageId: 'later', file: 'pages/Later.tsx', line: 2, col: 16, message: LAZY_MESSAGE },
      { code: 'syntax-error', pageId: 'home', file: 'pages/Home.tsx', line: 1, col: 1, message: 'pages/Home.tsx line 1: x' },
    ])
    const later = render(<CanvasEmptyPageHint pageId="later" />)
    const text = later.getByTestId('canvas-empty-page-hint').textContent ?? ''
    expect(text).toContain('can’t draw this page from its code')
    expect(text).toContain(LAZY_MESSAGE)
    expect(text).not.toContain('This page is empty.')
    cleanup()

    const home = render(<CanvasEmptyPageHint pageId="home" />)
    expect(home.getByTestId('canvas-empty-page-hint').textContent).toContain('This page is empty.')
  })

  it('follows the next load: a warning that stops applying disappears', () => {
    setStudioLoadWarnings([
      { code: 'unreadable-page-export', pageId: 'later', file: 'pages/Later.tsx', line: 2, col: 16, message: LAZY_MESSAGE },
    ])
    const view = render(<CanvasEmptyPageHint pageId="later" />)
    expect(view.getByTestId('canvas-empty-page-hint').textContent).toContain(LAZY_MESSAGE)
    act(() => setStudioLoadWarnings([]))
    expect(view.getByTestId('canvas-empty-page-hint').textContent).toContain('This page is empty.')
  })
})
