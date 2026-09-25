import { isIP } from 'node:net'

/**
 * The shared SSRF guard behind every server-side fetch of a URL the server did
 * not choose: the QuickJS plugin sandbox's `network.outbound` gate
 * (`server/plugins/host/network.ts`) and the Studio asset fetcher
 * (`server/handlers/studio/remoteAssetFetch.ts`). One blocklist and one
 * resolve-then-pin step, so neither caller can drift from the other.
 *
 * ## Two halves
 *
 * 1. {@link isBlockedAddress} classifies a RESOLVED address — never a host
 *    name. It parses the address into its bytes first, so every spelling of
 *    one address (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`,
 *    `::ffff:7f00:0001`) gets one answer, and it knows the transition formats
 *    that carry an IPv4 address inside an IPv6 one (IPv4-mapped, the
 *    deprecated IPv4-compatible `::a.b.c.d`, SIIT's `::ffff:0:a.b.c.d`, NAT64's
 *    `64:ff9b::/96`), judging the embedded IPv4 address rather than the
 *    wrapper.
 * 2. {@link resolvePinnedAddresses} + {@link pinUrlToAddress} are the
 *    CONNECT-TIME half. A caller resolves the host once, every address is
 *    judged, and the request then connects to exactly one of those validated
 *    addresses — the URL's host is rewritten to the address, the original
 *    name travels as the `Host` header and the TLS `serverName` (Bun checks
 *    the certificate against `serverName`: measured, a pinned request to
 *    `wrong.host.badssl.com`'s address fails with ERR_TLS_CERT_ALTNAME_INVALID).
 *    Checking the name and then letting `fetch` resolve it again is exactly
 *    the gap DNS rebinding needs: public at the check, private at the
 *    connect. Bun's `fetch` has no per-connection lookup hook, so pinning is
 *    how "check at connect time" is expressed here.
 *
 * ## What it does not cover
 *
 * A resolver that is already compromised when the one lookup runs (it lies
 * about a public name on the first answer) is outside what an application
 * guard can see.
 */

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

/** Four octets, or `null` for anything that is not a canonical dotted quad. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets as [number, number, number, number]
}

/**
 * The eight 16-bit groups of an IPv6 address, or `null` when it does not
 * parse. Handles `::` compression, an embedded dotted IPv4 tail
 * (`::ffff:1.2.3.4`) and a zone id (`fe80::1%eth0`, dropped).
 */
function parseIpv6(raw: string): number[] | null {
  const addr = (raw.split('%')[0] ?? '').toLowerCase()
  if (addr.length === 0 || addr.length > 45) return null

  let tail: number[] = []
  let text = addr
  const lastColon = text.lastIndexOf(':')
  const maybeV4 = text.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const v4 = parseIpv4(maybeV4)
    if (!v4) return null
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    text = text.slice(0, lastColon + 1)
    // `::1.2.3.4` leaves `::`, `1::1.2.3.4` leaves `1::`, `a:b:c:d:e:f:1.2.3.4` leaves `a:b:c:d:e:f:`.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1)
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const toGroups = (part: string): number[] | null => {
    if (part.length === 0) return []
    const groups: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      groups.push(parseInt(piece, 16))
    }
    return groups
  }
  const head = toGroups(halves[0] ?? '')
  if (head === null) return null
  if (halves.length === 1) {
    const groups = [...head, ...tail]
    return groups.length === 8 ? groups : null
  }
  const rest = toGroups(halves[1] ?? '')
  if (rest === null) return null
  const known = head.length + rest.length + tail.length
  if (known > 7) return null
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail]
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * IPv4 special-purpose ranges no server-side fetch may reach (IANA's IPv4
 * special-purpose registry, less the globally reachable entries).
 */
function isBlockedIpv4Octets([a, b, c]: readonly [number, number, number, number]): boolean {
  if (a === 0) return true // 0.0.0.0/8 "this network", including the unspecified address
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT (also cloud metadata: Alibaba's 100.100.100.200)
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local, including 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 192.88.99.0/24 6to4 relay anycast
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false
}

function embeddedIpv4(groups: readonly number[], from: number): [number, number, number, number] {
  const hi = groups[from]!
  const lo = groups[from + 1]!
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

function isBlockedIpv6Groups(g: readonly number[]): boolean {
  const zeroUpTo = (n: number): boolean => g.slice(0, n).every((group) => group === 0)
  // ::ffff:0:0/96 IPv4-mapped — the embedded address decides.
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedIpv4Octets(embeddedIpv4(g, 6))
  // ::ffff:0:0:0/96 IPv4-translated (SIIT) — the embedded address decides.
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIpv4Octets(embeddedIpv4(g, 6))
  // ::/96 — unspecified, loopback, and the deprecated IPv4-compatible form
  // (`::7f00:1`). Nothing legitimate is served there: all of it is refused.
  if (zeroUpTo(6)) return true
  // 64:ff9b::/96 NAT64 well-known prefix — the embedded address decides: a
  // NAT64 gateway forwards to it, so `64:ff9b::a9fe:a9fe` is the metadata
  // address and `64:ff9b::808:808` is a public one.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4Octets(embeddedIpv4(g, 6))
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // 100::/64 discard-only
  if (g[0] === 0x2001 && g[1]! < 0x200) return true // 2001::/23 IETF protocol assignments: Teredo, benchmarking (2001:2::/48), ORCHID
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return true // 2002::/16 6to4 — carries an arbitrary IPv4 address, loopback included
  if (g[0] === 0x3fff && g[1]! < 0x1000) return true // 3fff::/20 documentation
  const first = g[0]!
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True for a loopback address specifically — 127.0.0.0/8, `::1`, and the
 * IPv4-mapped/translated spellings of 127/8. A strict SUBSET of
 * {@link isBlockedAddress}: RFC1918, CGNAT, link-local (the 169.254.169.254
 * metadata address) and unique-local are NOT loopback, and stay blocked even
 * when a caller opts into loopback. The IPv4-compatible `::127.0.0.1` is not
 * loopback on any current OS and is not treated as one.
 */
export function isLoopbackAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return parseIpv4(ip)?.[0] === 127
  if (family !== 6) return false
  const g = parseIpv6(ip)
  if (!g) return false
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return true
  const mapped = g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff
  const translated = g.slice(0, 4).every((group) => group === 0) && g[4] === 0xffff && g[5] === 0
  return (mapped || translated) && g[6]! >> 8 === 127
}

export interface BlockedAddressOptions {
  /**
   * Treat loopback as reachable. OFF everywhere by default, and deliberately
   * a per-CALLER opt-in rather than a global switch: this module is also the
   * QuickJS plugin sandbox's `network.outbound` gate, where loopback access
   * would let untrusted plugin code reach every service on the host. Only the
   * Studio asset fetcher passes it, and only when its own env var is set.
   */
  readonly allowLoopback?: boolean
}

/**
 * True for any address in a range no server-side fetch may reach — see the
 * two classifiers above for the list. A string that is not an IP address, or
 * that `isIP` accepts but this module cannot parse, is blocked: fail closed.
 * Callers resolve host names to addresses first.
 */
export function isBlockedAddress(ip: string, options: BlockedAddressOptions = {}): boolean {
  if (options.allowLoopback && isLoopbackAddress(ip)) return false
  const family = isIP(ip)
  if (family === 4) {
    const octets = parseIpv4(ip)
    return octets === null || isBlockedIpv4Octets(octets)
  }
  if (family === 6) {
    const groups = parseIpv6(ip)
    return groups === null || isBlockedIpv6Groups(groups)
  }
  return true
}

/** Strips the `[...]` wrapper a `URL#hostname` puts around a literal IPv6 address. No-op for anything else. */
export function stripHostnameBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

// ---------------------------------------------------------------------------
// Connect-time pinning
// ---------------------------------------------------------------------------

export type PinnedAddressResolution =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly reason: 'unresolved' | 'blocked'; readonly blockedAddress?: string }

/**
 * Every address `hostname` names — a literal IP is itself, a name goes through
 * `resolveHostAddresses`, which must return EVERY record (a rebinding answer
 * can mix public and private records hoping only the first is checked) — each
 * judged by {@link isBlockedAddress}. The whole set must be clean. The caller
 * then connects to one of the returned addresses through
 * {@link pinUrlToAddress}, never to the name again.
 */
export async function resolvePinnedAddresses(
  hostname: string,
  resolveHostAddresses: (host: string) => Promise<string[]>,
  options: BlockedAddressOptions = {},
): Promise<PinnedAddressResolution> {
  const host = stripHostnameBrackets(hostname)
  const addresses = isIP(host) !== 0 ? [host] : await resolveHostAddresses(host)
  if (addresses.length === 0) return { ok: false, reason: 'unresolved' }
  for (const address of addresses) {
    if (isBlockedAddress(address, options)) return { ok: false, reason: 'blocked', blockedAddress: address }
  }
  return { ok: true, addresses }
}

/**
 * `url` with its host replaced by the validated `address` — the connection
 * target. The original `url.host` / `url.hostname` are what the caller sends
 * as the `Host` header and the TLS `serverName` ({@link pinnedRequestInit}).
 */
export function pinUrlToAddress(url: URL, address: string): URL {
  const pinned = new URL(url.toString())
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
  return pinned
}

/**
 * The request options that keep a pinned request addressed to the ORIGINAL
 * host: `Host` from the URL (overriding any caller-supplied `host`, which
 * would otherwise pick a different virtual host than the one validated), and
 * the TLS `serverName` so SNI and the certificate check use the name, not the
 * address.
 */
export function pinnedRequestInit(url: URL, headers: Record<string, string> | undefined): {
  headers: Record<string, string>
  tls?: { serverName: string }
} {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== 'host') next[key] = value
  }
  next.host = url.host
  return url.protocol === 'https:' ? { headers: next, tls: { serverName: stripHostnameBrackets(url.hostname) } } : { headers: next }
}
