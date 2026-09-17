/**
 * `sec-10` — the PARENT's own rate bound on a live frame's `error` messages.
 *
 * `sec-06`'s same-realm spoofing finding says the honest sender is exactly the
 * thing an attacker replaces: a script co-resident with `runtime.ts` in the live
 * frame's document posts `to-parent` envelopes directly, so
 * `runtimeErrorTaps.ts`'s 10/second and 50/document caps bind nothing. The size
 * bound (`ErrorMessageSchema`'s `maxLength`s) and the count bound
 * (`MAX_DISTINCT_ENTRIES`) are already enforced on this side; the rate was not,
 * and every accepted record costs the trusted parent a copy-and-sort of the
 * whole published array plus a React notification.
 *
 * Tested as data rather than through a mounted component for the same reason
 * `canvasDiagnosticsScope.test.ts` is: the bound is a pure property of the gate,
 * and a real clock would make the test slow and flaky.
 */
import { describe, expect, it } from 'bun:test'
import {
  admitBridgeDiagnostic,
  MAX_BRIDGE_DIAGNOSTICS_PER_SECOND,
} from '@site/canvas/useBridgeFrameDiagnostics'

/** A clock the test drives by hand, so a "second" costs no wall-clock time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('admitBridgeDiagnostic', () => {
  it('admits everything an honest frame can send — its 10/second is far inside the budget', () => {
    const clock = fakeClock()
    const admit = admitBridgeDiagnostic(clock.now)
    for (let second = 0; second < 5; second += 1) {
      for (let i = 0; i < 10; i += 1) expect(admit()).toBe(true)
      clock.advance(1000)
    }
  })

  it('drops a forged flood past the budget inside one window', () => {
    const clock = fakeClock()
    const admit = admitBridgeDiagnostic(clock.now)

    let admitted = 0
    // A same-realm forger posting the SAME message 100_000 times: each repeat
    // would otherwise bump a count and re-publish the whole array.
    for (let i = 0; i < 100_000; i += 1) if (admit()) admitted += 1

    expect(admitted).toBe(MAX_BRIDGE_DIAGNOSTICS_PER_SECOND)
  })

  it('is a bound on the RATE, not a lifetime cap — a frame reloaded all day keeps reporting', () => {
    const clock = fakeClock()
    const admit = admitBridgeDiagnostic(clock.now)

    for (let i = 0; i < 100_000; i += 1) admit()
    clock.advance(1000)

    // A cross-origin frame keeps one stable `WindowProxy` across reloads, so a
    // lifetime cap here would silently stop reporting a frame the user merely
    // reloaded. The next window starts clean.
    expect(admit()).toBe(true)
  })

  it('gives each frame its own budget — one noisy frame never silences another', () => {
    const clock = fakeClock()
    const noisy = admitBridgeDiagnostic(clock.now)
    const quiet = admitBridgeDiagnostic(clock.now)

    for (let i = 0; i < 100_000; i += 1) noisy()

    expect(noisy()).toBe(false)
    expect(quiet()).toBe(true)
  })
})
