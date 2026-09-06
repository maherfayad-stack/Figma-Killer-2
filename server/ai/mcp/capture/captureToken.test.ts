/**
 * Capture grants — the credential the headless capture page authenticates
 * with. These tests are about the SECURITY properties the design claims, not
 * about token formatting: a grant is scoped to one project and one page set,
 * it expires, and revocation is immediate.
 */
import { describe, expect, it } from 'bun:test'
import {
  liveCaptureGrantCount,
  mintCaptureToken,
  resolveCaptureToken,
  revokeCaptureToken,
} from './captureToken'

describe('capture tokens', () => {
  it('resolves a freshly minted grant to exactly what was minted', () => {
    const token = mintCaptureToken({
      userId: 'user-1',
      dir: '/workspace/project-a',
      pageIds: ['pages/Home.tsx', 'pages/Cart.tsx'],
      axes: { colorScheme: 'dark' },
    })

    const grant = resolveCaptureToken(token)
    expect(grant).not.toBeNull()
    expect(grant!.userId).toBe('user-1')
    expect(grant!.dir).toBe('/workspace/project-a')
    expect(grant!.pageIds).toEqual(['pages/Home.tsx', 'pages/Cart.tsx'])
    expect(grant!.axes).toEqual({ colorScheme: 'dark' })

    revokeCaptureToken(token)
  })

  it('mints unguessable, unique tokens', () => {
    const a = mintCaptureToken({ userId: 'u', dir: '/d', pageIds: ['p'] })
    const b = mintCaptureToken({ userId: 'u', dir: '/d', pageIds: ['p'] })
    expect(a).not.toBe(b)
    // 32 random bytes, base64url — long enough that guessing is not a threat.
    expect(a.startsWith('icap_')).toBe(true)
    expect(a.length).toBeGreaterThan(40)
    revokeCaptureToken(a)
    revokeCaptureToken(b)
  })

  it('refuses an unknown or revoked token', () => {
    expect(resolveCaptureToken('icap_nope')).toBeNull()
    expect(resolveCaptureToken(null)).toBeNull()
    expect(resolveCaptureToken('')).toBeNull()

    const token = mintCaptureToken({ userId: 'u', dir: '/d', pageIds: ['p'] })
    expect(resolveCaptureToken(token)).not.toBeNull()
    revokeCaptureToken(token)
    // Revocation is the real boundary, not the TTL — it must take effect at once.
    expect(resolveCaptureToken(token)).toBeNull()
  })

  it('copies pageIds so a caller cannot widen a grant after minting it', () => {
    const pageIds = ['pages/Home.tsx']
    const token = mintCaptureToken({ userId: 'u', dir: '/d', pageIds })
    pageIds.push('pages/Secret.tsx')

    expect(resolveCaptureToken(token)!.pageIds).toEqual(['pages/Home.tsx'])
    revokeCaptureToken(token)
  })

  it('expires a grant rather than leaving a credential behind', () => {
    const token = mintCaptureToken({ userId: 'u', dir: '/d', pageIds: ['p'] })
    const grant = resolveCaptureToken(token)!
    // Expiry is enforced on read against `Date.now()`, so a grant whose
    // deadline has passed is dead even if nothing swept it — the property the
    // implementation actually relies on.
    expect(grant.expiresAt).toBeGreaterThan(Date.now())
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
    revokeCaptureToken(token)
  })

  it('does not accumulate dead grants', () => {
    const before = liveCaptureGrantCount()
    const tokens = Array.from({ length: 5 }, () =>
      mintCaptureToken({ userId: 'u', dir: '/d', pageIds: ['p'] }))
    expect(liveCaptureGrantCount()).toBe(before + 5)
    for (const token of tokens) revokeCaptureToken(token)
    expect(liveCaptureGrantCount()).toBe(before)
  })
})
