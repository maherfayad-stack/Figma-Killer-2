import { isIP } from 'node:net'

/**
 * The shared "is this a private/internal network address" classifier behind
 * every outbound-fetch SSRF guard in the server. Originally lived only in
 * `server/plugins/host/network.ts` (the QuickJS plugin sandbox's
 * `network.outbound` gate); extracted here so `server/handlers/studio/
 * remoteAssetFetch.ts` (a server-side fetch of a caller-supplied URL, same
 * threat model, different subsystem) can share ONE blocklist instead of a
 * second hand-maintained copy that could silently drift from this one.
 *
 * This is a blocklist of RESOLVED ADDRESSES, not hostnames — callers must
 * resolve a hostname to its addresses first (DNS) and check every one of
 * them; checking only the hostname string is exactly what DNS rebinding
 * defeats (a name that resolves public at validation time and private at
 * connect time).
 */

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true // malformed — fail closed
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

function isBlockedIpv6(raw: string): boolean {
  const addr = (raw.split('%')[0] ?? '').toLowerCase() // drop zone id
  // IPv4-mapped, dotted form: ::ffff:127.0.0.1
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  if (dotted?.[1]) return isBlockedIpv4(dotted[1])
  // IPv4-mapped, hex form: ::ffff:7f00:0001
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true // loopback
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true // unspecified
  if (/^f[cd]/.test(addr)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true // fe80::/10 link-local
  return false
}

/**
 * True for any address in a loopback / private / link-local / CGNAT /
 * unique-local / unspecified range — the SSRF blocklist. Non-IP strings
 * return `false` (the caller resolves hostnames to addresses first).
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isBlockedIpv4(ip)
  if (family === 6) return isBlockedIpv6(ip)
  return false
}

/** Strips the `[...]` wrapper a `URL#hostname` puts around a literal IPv6 address. No-op for anything else. */
export function stripHostnameBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}
