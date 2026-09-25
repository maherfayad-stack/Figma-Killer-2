/**
 * SSRF blocklist — and the narrow loopback opt-in.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that opting into
 * loopback opens loopback and nothing else, and that the default (which the
 * QuickJS plugin sandbox's `network.outbound` gate relies on) is unchanged.
 */
import { describe, expect, it } from 'bun:test'
import { isBlockedAddress, isLoopbackAddress, pinnedRequestInit, pinUrlToAddress, resolvePinnedAddresses } from './ssrfGuard'
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

// Security review of #248, F5, and the P4-E follow-up: address classes the
// first classifier missed, each a way to reach something local through a
// spelling that is not the plain one.
describe('isBlockedAddress — every spelling of a local address (F5)', () => {
  const BLOCKED: ReadonlyArray<readonly [string, string]> = [
    ['::7f00:1', 'IPv4-compatible ::127.0.0.1'],
    ['::127.0.0.1', 'IPv4-compatible, dotted'],
    ['::a9fe:a9fe', 'IPv4-compatible metadata address'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'IPv4-mapped metadata, fully expanded'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of 169.254.169.254'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
    ['64:ff9b::10.0.0.1', 'NAT64 of RFC1918, dotted'],
    ['64:ff9b:1::1', 'local-use NAT64 prefix'],
    ['2002:7f00:1::', '6to4 wrapping 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 wrapping the metadata address'],
    ['2001::1', 'Teredo'],
    ['2001:2::1', 'IPv6 benchmarking'],
    ['2001:db8::1', 'IPv6 documentation'],
    ['100::1', 'discard-only'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['FE80::1%eth0', 'link-local with a zone id, upper case'],
    ['fd00:ec2::254', 'AWS IPv6 metadata (unique-local)'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['100.100.100.200', 'CGNAT (Alibaba metadata)'],
    ['198.18.0.1', 'benchmarking 198.18.0.0/15'],
    ['198.19.255.254', 'benchmarking, top of the range'],
    ['192.0.0.170', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast (SSDP)'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ]
  for (const [ip, label] of BLOCKED) {
    it(`blocks ${ip} (${label})`, () => {
      expect(isBlockedAddress(ip)).toBe(true)
      expect(isBlockedAddress(ip, { allowLoopback: true })).toBe(true)
    })
  }

  it('still allows public addresses, including one reached through NAT64 and the edges of each blocked range', () => {
    for (const ip of ['64:ff9b::808:808', '198.20.0.1', '198.17.255.255', '192.0.3.1', '223.255.255.255', '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })

  it('treats the fully expanded and mapped loopback spellings as loopback, and the IPv4-compatible one as not', () => {
    expect(isBlockedAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true)
    expect(isBlockedAddress('::ffff:0:7f00:1')).toBe(true)
    expect(isLoopbackAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true)
    expect(isLoopbackAddress('::ffff:0:7f00:1')).toBe(true)
    expect(isBlockedAddress('0:0:0:0:0:ffff:7f00:1', { allowLoopback: true })).toBe(false)
    expect(isLoopbackAddress('::7f00:1')).toBe(false)
  })

  it('fails closed on a string that is not an address', () => {
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})

describe('resolvePinnedAddresses — the connect-time half', () => {
  it('refuses the whole set when ANY record is local (a rebinding answer mixes them)', async () => {
    const out = await resolvePinnedAddresses('mixed.example', async () => ['93.184.216.34', '64:ff9b::a9fe:a9fe'])
    expect(out.ok).toBe(false)
  })

  it('returns every validated address, and a literal IP resolves to itself without a lookup', async () => {
    let lookups = 0
    const out = await resolvePinnedAddresses('[2606:4700::1111]', async () => { lookups += 1; return [] })
    expect(out).toEqual({ ok: true, addresses: ['2606:4700::1111'] })
    expect(lookups).toBe(0)
  })

  it('pins the URL to the address and keeps the name for Host and SNI, dropping a caller-supplied host header', () => {
    const url = new URL('https://assets.example.com:8443/a.png?x=1')
    expect(pinUrlToAddress(url, '2606:4700::1111').toString()).toBe('https://[2606:4700::1111]:8443/a.png?x=1')
    expect(pinnedRequestInit(url, { Host: 'internal.local', accept: '*/*' })).toEqual({
      headers: { accept: '*/*', host: 'assets.example.com:8443' },
      tls: { serverName: 'assets.example.com' },
    })
  })
})
