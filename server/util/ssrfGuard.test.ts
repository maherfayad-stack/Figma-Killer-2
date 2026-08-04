/**
 * SSRF blocklist — and the narrow loopback opt-in.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that opting into
 * loopback opens loopback and nothing else, and that the default (which the
 * QuickJS plugin sandbox's `network.outbound` gate relies on) is unchanged.
 */
import { describe, expect, it } from 'bun:test'
import { isBlockedAddress, isLoopbackAddress } from './ssrfGuard'
import { loopbackAssetFetchEnabled } from '../handlers/studio/remoteAssetFetch'

const LOOPBACK = ['127.0.0.1', '127.1.2.3', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:0001']

// Private/internal but NOT loopback — these must stay blocked even when a
// caller opts in. 169.254.169.254 is the cloud-metadata address, the single
// highest-value SSRF target and the reason this list is asserted explicitly.
const PRIVATE_NOT_LOOPBACK = ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::', 'fc00::1', 'fe80::1']

describe('isLoopbackAddress', () => {
  it('recognises every loopback spelling', () => {
    for (const ip of LOOPBACK) expect(isLoopbackAddress(ip)).toBe(true)
  })

  it('does not treat other private ranges as loopback', () => {
    for (const ip of PRIVATE_NOT_LOOPBACK) expect(isLoopbackAddress(ip)).toBe(false)
  })

  it('does not treat public addresses as loopback', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isLoopbackAddress(ip)).toBe(false)
    }
  })
})

describe('isBlockedAddress', () => {
  // The plugin sandbox calls this with no options — this is that contract.
  it('blocks loopback by default', () => {
    for (const ip of LOOPBACK) expect(isBlockedAddress(ip)).toBe(true)
  })

  it('blocks every private range by default', () => {
    for (const ip of PRIVATE_NOT_LOOPBACK) expect(isBlockedAddress(ip)).toBe(true)
  })

  it('allows loopback ONLY when the caller opts in', () => {
    for (const ip of LOOPBACK) {
      expect(isBlockedAddress(ip, { allowLoopback: true })).toBe(false)
    }
  })

  it('still blocks cloud metadata and RFC1918 when loopback is opted into', () => {
    for (const ip of PRIVATE_NOT_LOOPBACK) {
      expect(isBlockedAddress(ip, { allowLoopback: true })).toBe(true)
    }
  })

  it('allows public addresses either way', () => {
    for (const ip of ['8.8.8.8', '2606:4700::1111']) {
      expect(isBlockedAddress(ip)).toBe(false)
      expect(isBlockedAddress(ip, { allowLoopback: true })).toBe(false)
    }
  })
})

describe('loopbackAssetFetchEnabled', () => {
  it('is on only for an explicit 1 or true', () => {
    for (const raw of ['1', 'true', 'TRUE', ' true ']) {
      expect(loopbackAssetFetchEnabled({ STUDIO_ALLOW_LOOPBACK_ASSET_FETCH: raw })).toBe(true)
    }
  })

  // An unset or typo'd variable must never read as consent.
  it('is off for anything else', () => {
    for (const raw of ['0', 'false', '', 'yes', 'on']) {
      expect(loopbackAssetFetchEnabled({ STUDIO_ALLOW_LOOPBACK_ASSET_FETCH: raw })).toBe(false)
    }
    expect(loopbackAssetFetchEnabled({})).toBe(false)
  })
})
