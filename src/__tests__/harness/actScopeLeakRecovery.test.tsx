/**
 * The contract that keeps one slow test from taking the whole suite with it.
 *
 * React's `act()` unwinds its module-private `actScopeDepth` / `actQueue` in
 * the `.then()` handlers of the promise `await act(async () => …)` returns.
 * When bun's per-test timeout fires it abandons the test's async frame, that
 * promise never settles, and both stay leaked for the REST OF THE PROCESS.
 * Every later `render()` — in every later FILE, when the suite shares one
 * process — then queues work that is never flushed and commits nothing.
 *
 * `src/__tests__/setup.ts` repairs that in its global `afterEach`. This file
 * reproduces the leak deliberately (a floating `await act(...)` that is still
 * open when the test ends is exactly the state a timeout leaves behind) and
 * asserts that the very next test still commits a render.
 *
 * Without the repair the second test fails with an empty container — the
 * signature of the CI-wide wipeout this guard exists to prevent.
 */
import { describe, expect, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'

let releaseStuckAct: (() => void) | null = null

describe('a leaked act() scope does not brick React for later tests', () => {
  test('opens an act() scope that is still pending when the test ends', () => {
    const stuck = new Promise<void>((resolve) => {
      releaseStuckAct = resolve
    })

    // Fire-and-forget on purpose. The `await` inside registers React's
    // unwind handlers (so this is the timed-out-test shape, not the
    // never-awaited-act shape), then the test returns while the scope is
    // still open — precisely what bun leaves behind on a timeout.
    void (async () => {
      await act(async () => {
        await stuck
      })
    })()

    expect(releaseStuckAct).not.toBeNull()
  })

  test('the next test still commits a render', () => {
    render(<div data-testid="commits-after-a-leaked-act-scope">rendered</div>)
    expect(screen.getByTestId('commits-after-a-leaked-act-scope').textContent).toBe('rendered')
  })

  test('and a second render after that still commits, so the repair is not one-shot', () => {
    releaseStuckAct?.()
    render(<div data-testid="still-commits">rendered again</div>)
    expect(screen.getByTestId('still-commits').textContent).toBe('rendered again')
  })
})
