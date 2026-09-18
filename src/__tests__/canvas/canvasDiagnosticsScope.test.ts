/**
 * Z5/P8 — the scope-keyed publication side of `canvasDiagnosticsBuffer.ts`,
 * which is what a frame badge and the Play surface's crash card subscribe to.
 *
 * The thing worth protecting here is the `useSyncExternalStore` contract: the
 * published array must be a STABLE reference between records and a NEW one
 * after each, or React either loops forever or never re-renders. That is a
 * pure-data property, so it is tested as data rather than through a component.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  disposeFrameDiagnostics,
  ensureFrameDiagnostics,
  getScopeDiagnostics,
  isCrashDiagnostic,
  recordFrameDiagnostic,
  subscribeScopeDiagnostics,
} from '@site/canvas/canvasDiagnosticsBuffer'

/** A stand-in for a frame's `Window`: the buffer only ever uses it as a `WeakMap` key. */
function fakeFrameWindow(): Window {
  return {} as Window
}

const views: Window[] = []

function installed(scopeKey?: string): Window {
  const view = fakeFrameWindow()
  views.push(view)
  ensureFrameDiagnostics(view, scopeKey)
  return view
}

afterEach(() => {
  for (const view of views) disposeFrameDiagnostics(view)
  views.length = 0
})

describe('canvasDiagnosticsBuffer — scope publication', () => {
  it('publishes to the scope key and notifies subscribers, newest problem first', () => {
    const view = installed('frame-1')
    let notifications = 0
    const unsubscribe = subscribeScopeDiagnostics('frame-1', () => {
      notifications += 1
    })

    recordFrameDiagnostic(view, { kind: 'consoleError', code: 'runtime-console-error', message: 'first' })
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'second' })

    expect(notifications).toBe(2)
    expect(getScopeDiagnostics('frame-1').map((e) => e.message)).toEqual(['second', 'first'])
    unsubscribe()
  })

  it('returns a STABLE array between records and a new one after each — the useSyncExternalStore contract', () => {
    const view = installed('frame-2')

    const before = getScopeDiagnostics('frame-2')
    expect(getScopeDiagnostics('frame-2')).toBe(before)

    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'boom' })
    const after = getScopeDiagnostics('frame-2')
    expect(after).not.toBe(before)
    expect(getScopeDiagnostics('frame-2')).toBe(after)
  })

  it('re-publishes on a REPEAT so the count on screen keeps up with reality', () => {
    const view = installed('frame-3')
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'loop' })
    const first = getScopeDiagnostics('frame-3')
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'loop' })

    expect(getScopeDiagnostics('frame-3')).not.toBe(first)
    expect(getScopeDiagnostics('frame-3')).toHaveLength(1)
    expect(getScopeDiagnostics('frame-3')[0]!.count).toBe(2)
  })

  it('clears the scope when the frame installs a fresh buffer — a reloaded frame must not show the old document’s errors', () => {
    const view = installed('frame-4')
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'stale' })
    expect(getScopeDiagnostics('frame-4')).toHaveLength(1)

    disposeFrameDiagnostics(view)
    installed('frame-4')
    expect(getScopeDiagnostics('frame-4')).toHaveLength(0)
  })

  it('collects for the agent but notifies nobody when the frame has no scope key', () => {
    const view = installed()
    recordFrameDiagnostic(view, { kind: 'uncaughtError', code: 'runtime-uncaught-error', message: 'unscoped' })
    expect(getScopeDiagnostics('')).toHaveLength(0)
  })

  it('separates "this screen did not render" from "something on it complained"', () => {
    expect(
      isCrashDiagnostic({
        kind: 'uncaughtError',
        code: 'runtime-uncaught-error',
        message: 'x',
        count: 1,
        firstAt: 0,
        lastAt: 0,
      }),
    ).toBe(true)
    expect(
      isCrashDiagnostic({
        kind: 'network',
        code: 'network-request-failed',
        message: 'x',
        count: 1,
        firstAt: 0,
        lastAt: 0,
      }),
    ).toBe(false)
  })
})
