/**
 * deviceKind — which mockup live mode draws around a breakpoint.
 *
 * The rule that actually matters here is the PRECEDENCE: a breakpoint's `icon`
 * is an explicit statement about what device the context represents, so it has
 * to beat the width heuristic in both directions. A 1280px context iconed
 * `tablet` is a tablet; a 375px context iconed `monitor` is not a phone. Get
 * that backwards and every site with a custom viewport context silently gets
 * the wrong chrome, which is the exact failure mode matching on breakpoint
 * `id` would have had.
 */
import { describe, expect, it } from 'bun:test'
import { DEFAULT_BREAKPOINTS, type Breakpoint } from '@core/page-tree'
import { DEVICE_BEZEL_PX, resolveDeviceKind } from '@site/canvas/deviceKind'

function breakpoint(over: Partial<Breakpoint>): Breakpoint {
  return { id: 'x', label: 'X', width: 375, icon: 'smartphone', ...over }
}

describe('resolveDeviceKind', () => {
  it('draws a phone, a tablet and nothing for the three seeded breakpoints', () => {
    const byId = Object.fromEntries(DEFAULT_BREAKPOINTS.map((b) => [b.id, resolveDeviceKind(b)]))
    expect(byId).toEqual({ mobile: 'phone', tablet: 'tablet', desktop: null })
  })

  it('lets the icon beat the width heuristic in both directions', () => {
    // Wide, but the author said tablet.
    expect(resolveDeviceKind(breakpoint({ width: 1280, icon: 'tablet' }))).toBe('tablet')
    // Narrow, but the author said monitor — `monitor` is an ANSWER ("not a
    // device"), not a gap, so it must not fall through to the width rule.
    expect(resolveDeviceKind(breakpoint({ width: 375, icon: 'monitor' }))).toBe(null)
  })

  it('falls back to width when the icon names no device', () => {
    // `icon` is a free-form pixel-art-icons name; a site may use anything.
    expect(resolveDeviceKind(breakpoint({ width: 320, icon: 'bookmark' }))).toBe('phone')
    expect(resolveDeviceKind(breakpoint({ width: 834, icon: 'bookmark' }))).toBe('tablet')
    expect(resolveDeviceKind(breakpoint({ width: 1440, icon: 'bookmark' }))).toBe(null)
  })

  it('draws nothing while the breakpoint is still hydrating', () => {
    // Guessing here would flash a phone around a skeleton that turns out to be
    // a desktop, on every load.
    expect(resolveDeviceKind(null)).toBe(null)
  })

  it('gives every device a bezel, since the width fitting subtracts it', () => {
    for (const kind of ['phone', 'tablet'] as const) {
      expect(DEVICE_BEZEL_PX[kind]).toBeGreaterThan(0)
    }
  })
})
