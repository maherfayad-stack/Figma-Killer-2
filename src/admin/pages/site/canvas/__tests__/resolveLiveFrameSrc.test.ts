/**
 * resolveLiveFrameSrc — the exact URL shape a bridge-mode iframe's `src=`
 * resolves to (`live-06`, STATE.md). No test file existed for this function
 * before this one.
 */
import { describe, expect, it } from 'bun:test'
import { resolveLiveFrameSrc, type LiveFrameSource } from '../resolveLiveFrameSrc'

function source(overrides: Partial<LiveFrameSource> = {}): LiveFrameSource {
  return {
    liveOrigin: 'https://live.studio.test',
    screenKey: 'home',
    nodeIdsInTreeOrder: [],
    axes: { direction: 'ltr', colorScheme: 'light' },
    ...overrides,
  }
}

describe('resolveLiveFrameSrc', () => {
  it('builds <liveOrigin>/__screen/<key>?dir=&theme= for the default (no-locale) axes', () => {
    expect(resolveLiveFrameSrc(source())).toBe('https://live.studio.test/__screen/home?dir=ltr&theme=light')
  })

  it('carries dir=rtl and theme=dark through unchanged', () => {
    const url = resolveLiveFrameSrc(source({ axes: { direction: 'rtl', colorScheme: 'dark' } }))
    expect(url).toBe('https://live.studio.test/__screen/home?dir=rtl&theme=dark')
  })

  it('adds lang= only when axes.locale is set — omitted entirely otherwise', () => {
    const withLocale = resolveLiveFrameSrc(source({ axes: { direction: 'ltr', colorScheme: 'light', locale: 'ar' } }))
    expect(withLocale).toBe('https://live.studio.test/__screen/home?dir=ltr&theme=light&lang=ar')

    const withoutLocale = resolveLiveFrameSrc(source())
    expect(withoutLocale).not.toContain('lang=')
  })

  it('percent-encodes a screenKey that needs it', () => {
    const url = resolveLiveFrameSrc(source({ screenKey: 'a b/c' }))
    expect(url).toContain('/__screen/a%20b%2Fc')
  })

  it('preserves a liveOrigin that already carries a /p/<projectKey> path segment', () => {
    const url = resolveLiveFrameSrc(source({ liveOrigin: 'https://live.studio.test/p/acme-app' }))
    expect(url).toBe('https://live.studio.test/p/acme-app/__screen/home?dir=ltr&theme=light')
  })
})
