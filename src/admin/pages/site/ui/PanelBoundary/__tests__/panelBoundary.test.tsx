/**
 * PanelBoundary — `panel-40`. One panel, one section, one failure domain.
 *
 * `verify-3` case 5 measured the defect: a throwing inspector section took the
 * canvas and the whole editor body with it, because the nearest boundary was
 * `LazyChunkBoundary location="site-editor-body"`.
 *
 * Covers:
 *   1. A section that throws renders its own fallback; its SIBLINGS keep
 *      rendering (this is the whole contract).
 *   2. The fallback keeps the section's title row and names the section.
 *   3. No toast — Z2's silent half, which `ErrorBoundary` defaults to and this
 *      component must not opt out of.
 *   4. Exactly ONE console line, tagged with the seam's own location.
 *   5. "Reload this panel" remounts the subtree, so a transient failure
 *      recovers in place.
 *   6. `frame="panel"` renders the panel-shaped fallback with the same
 *      `role="alert"` + `data-error-location` handles the browser gate uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { subscribeToasts, __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { PanelBoundary } from '../PanelBoundary'

afterEach(cleanup)

/**
 * A section whose failure the TEST turns off, not a render counter: React 19
 * replays a throwing render in dev to recover a better stack, so "throws once"
 * is consumed by the replay and the boundary never sees a second failure.
 */
function makeFlakySection() {
  const control = { throwing: true }
  function FlakySection() {
    if (control.throwing) throw new Error('FlakySection blew up')
    return <div data-testid="flaky-body">recovered</div>
  }
  return { FlakySection, control }
}

function AlwaysThrows(): never {
  throw new Error('AlwaysThrows blew up')
}

let consoleErrors: unknown[][] = []
let restoreConsole: (() => void) | null = null

beforeEach(() => {
  __resetToastBusForTests()
  consoleErrors = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args)
  }
  restoreConsole = () => {
    console.error = original
  }
})

afterEach(() => {
  restoreConsole?.()
  restoreConsole = null
})

describe('PanelBoundary — a crashed section takes only itself down', () => {
  it('renders the fallback in place and keeps every sibling section alive', () => {
    render(
      <>
        <PanelBoundary id="fill" label="Fill" frame="section">
          <AlwaysThrows />
        </PanelBoundary>
        <PanelBoundary id="stroke" label="Stroke" frame="section">
          <div data-testid="stroke-body">stroke rows</div>
        </PanelBoundary>
      </>,
    )

    expect(screen.getByTestId('stroke-body')).toBeTruthy()
    const fallback = screen.getByRole('alert')
    expect(fallback.getAttribute('data-error-location')).toBe('inspector:fill')
  })

  it('keeps the section title row and names the section in one line', () => {
    render(
      <PanelBoundary id="shadow" label="Shadow" frame="section">
        <AlwaysThrows />
      </PanelBoundary>,
    )

    // The `Section` primitive's own header — the row a working Shadow draws.
    expect(screen.getAllByText('Shadow').length).toBeGreaterThan(0)
    expect(screen.getByRole('alert').textContent).toContain('Shadow stopped responding.')
  })

  it('pushes no toast — Z2 makes every seam but admin-shell silent', () => {
    const pushed: string[] = []
    const unsubscribe = subscribeToasts((list) => {
      pushed.length = 0
      pushed.push(...list.map((t) => `${t.kind}:${t.title}`))
    })

    render(
      <PanelBoundary id="blur" label="Blur" frame="section">
        <AlwaysThrows />
      </PanelBoundary>,
    )

    unsubscribe()
    expect(pushed).toEqual([])
  })

  it('logs exactly one line, tagged with the seam it caught', () => {
    render(
      <PanelBoundary id="layout" label="Layout" frame="section">
        <AlwaysThrows />
      </PanelBoundary>,
    )

    // ONE head line per catch. `logErrorChain` may add `… caused by` /
    // `… componentStack` continuations off the same prefix — those are the
    // shared primitive's detail, not a second report of a second error.
    const head = consoleErrors.filter((args) => args[0] === '[error-boundary:inspector:layout]')
    expect(head.length).toBe(1)
    expect(String(head[0][1])).toContain('AlwaysThrows blew up')
  })

  it('"Reload this panel" remounts the section', () => {
    const { FlakySection, control } = makeFlakySection()
    render(
      <PanelBoundary id="text" label="Text" frame="section">
        <FlakySection />
      </PanelBoundary>,
    )

    expect(screen.getByRole('alert')).toBeTruthy()

    control.throwing = false
    fireEvent.click(screen.getByRole('button', { name: /reload this panel/i }))

    expect(screen.getByTestId('flaky-body')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('PanelBoundary — frame="panel"', () => {
  it('names the panel and carries the same alert handles the browser gate reads', () => {
    render(
      <PanelBoundary id="design" label="Design" frame="panel">
        <AlwaysThrows />
      </PanelBoundary>,
    )

    const fallback = screen.getByRole('alert')
    expect(fallback.getAttribute('data-error-location')).toBe('panel:design')
    expect(fallback.textContent).toContain('Design stopped responding.')
    expect(screen.getByRole('button', { name: /reload this panel/i })).toBeTruthy()
  })

  it('a crashed panel leaves its neighbour mounted', () => {
    render(
      <>
        <PanelBoundary id="prototype" label="Prototype" frame="panel">
          <AlwaysThrows />
        </PanelBoundary>
        <PanelBoundary id="inspect" label="Inspect" frame="panel">
          <div data-testid="inspect-body">inspect report</div>
        </PanelBoundary>
      </>,
    )

    expect(screen.getByTestId('inspect-body')).toBeTruthy()
    expect(screen.getAllByRole('alert').length).toBe(1)
  })
})
