/**
 * remoteAssetFetch — studio_fetch_remote_asset's server-side pipeline. Every
 * test here is adversarial except the two happy-path ones: this fetches an
 * untrusted URL and writes into a real repo, so the refusals ARE the
 * feature, same posture `assetUpload.test.ts` already establishes for the
 * upload side of `landAssetBytes`.
 *
 * Every test injects `resolveHostAddresses` — even the happy-path/non-SSRF
 * ones — because `fetchRemoteAsset` always resolves-and-validates the host
 * before ever calling `fetchImpl`; without the stub, tests would depend on
 * real DNS for a fake `cdn.example.com` hostname.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fetchRemoteAsset, MAX_REMOTE_ASSET_BYTES, type FetchRemoteAssetDeps } from './remoteAssetFetch'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-remote-asset-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const SVG_WITH_SCRIPT = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>')

/** A real, non-blocked public address — TEST-NET-3 (RFC 5737), never routable. */
const PUBLIC_IP = '203.0.113.10'

function okResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers })
}

/** Resolves every hostname to `PUBLIC_IP` unless a caller narrows it further. */
function publicResolver(overrides: Record<string, string[]> = {}): (host: string) => Promise<string[]> {
  return async (host: string) => overrides[host] ?? [PUBLIC_IP]
}

describe('fetchRemoteAsset — happy path', () => {
  it('fetches a PNG and lands it via the shared landAssetBytes pipeline', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/exports/icon.png', undefined, {
      fetchImpl: async () => okResponse(PNG_BYTES),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relPath).toBe('src/assets/icon.png')
    expect(result.bytesWritten).toBe(PNG_BYTES.length)
    expect(fs.readFileSync(path.join(dir, 'src/assets/icon.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('sanitizes fetched SVG content before writing it — the exact gap this pipeline closes', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/exports/icon.svg', undefined, {
      fetchImpl: async () => okResponse(SVG_WITH_SCRIPT),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const written = fs.readFileSync(path.join(dir, result.relPath), 'utf8')
    expect(written).not.toContain('<script')
    expect(written).not.toContain('alert(1)')
    expect(written).toContain('<circle')
  })

  it('derives the extension from the sniffed bytes, ignoring what the URL path suggests', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/exports/not-really.png', undefined, {
      fetchImpl: async () => okResponse(PNG_BYTES),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relPath).toBe('src/assets/not-really.png')
  })

  it('honors an explicit targetDir', async () => {
    fs.mkdirSync(path.join(dir, 'public', 'images'), { recursive: true })
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', 'public/images', {
      fetchImpl: async () => okResponse(PNG_BYTES),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relPath).toBe('public/images/x.png')
  })

  it('pins the outbound connection to the validated address, preserving the original Host and passing the original URL through untouched to the caller-visible result', async () => {
    let seenUrl: string | undefined
    let seenHost: string | undefined
    const deps: FetchRemoteAssetDeps = {
      fetchImpl: async (input, init) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        seenHost = (init?.headers as Record<string, string> | undefined)?.host
        return okResponse(PNG_BYTES)
      },
      resolveHostAddresses: publicResolver({ 'cdn.example.com': [PUBLIC_IP] }),
    }
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', undefined, deps)
    expect(result.ok).toBe(true)
    // The literal connection target is the resolved address, not the hostname —
    // this is the DNS-rebinding fix: no second, uncontrolled resolution happens
    // between validation and connection.
    expect(seenUrl).toContain(PUBLIC_IP)
    expect(seenUrl).not.toContain('cdn.example.com')
    // ...but the ORIGINAL hostname still travels as the Host header, so a
    // virtual-hosted / CDN-fronted target still resolves to the right vhost.
    expect(seenHost).toBe('cdn.example.com')
  })
})

describe('fetchRemoteAsset — untrusted URL, adversarial', () => {
  it('refuses a non-http(s) scheme', async () => {
    const result = await fetchRemoteAsset(dir, 'file:///etc/passwd', undefined, {
      fetchImpl: async () => okResponse(PNG_BYTES),
    })
    expect(result.ok).toBe(false)
  })

  it('refuses a data: URL', async () => {
    const result = await fetchRemoteAsset(dir, 'data:image/png;base64,iVBORw0KGgo=', undefined, {
      fetchImpl: async () => okResponse(PNG_BYTES),
    })
    expect(result.ok).toBe(false)
  })

  it('refuses an unparseable URL', async () => {
    const result = await fetchRemoteAsset(dir, 'not a url at all', undefined, {
      fetchImpl: async () => okResponse(PNG_BYTES),
    })
    expect(result.ok).toBe(false)
  })

  it('never follows a redirect — a redirecting fetch is refused outright', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', undefined, {
      fetchImpl: async () => {
        throw new TypeError('unexpected redirect')
      },
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('redirect')
  })

  it('refuses a non-2xx response', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/missing.png', undefined, {
      fetchImpl: async () => new Response('nope', { status: 404 }),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
  })

  it('refuses a response over the size cap by streamed byte count', async () => {
    const oversized = new Uint8Array(MAX_REMOTE_ASSET_BYTES + 1024)
    oversized.set(PNG_BYTES)
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/huge.png', undefined, {
      fetchImpl: async () => okResponse(oversized),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, 'src/assets'))).toBe(false)
  })

  it('refuses content that does not sniff as a recognized image, regardless of URL/content-type', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/exports/icon.png', undefined, {
      fetchImpl: async () => okResponse(new TextEncoder().encode('<html>not an image</html>'), { 'content-type': 'image/png' }),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, 'src/assets'))).toBe(false)
  })

  it('a network failure is reported plainly, not thrown, and never leaks the raw connection error', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', undefined, {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 203.0.113.10:443')
      },
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The raw connection-error detail (address, port, errno) must never reach the caller.
    expect(result.error).not.toContain('ECONNREFUSED')
    expect(result.error).not.toContain('203.0.113.10')
  })

  it('still refuses a traversal-shaped targetDir — the write side stays containment-checked regardless of transport', async () => {
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', '../../.ssh', {
      fetchImpl: async () => okResponse(PNG_BYTES),
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(path.dirname(dir)), '.ssh'))).toBe(false)
  })
})

describe('fetchRemoteAsset — SSRF: loopback, cloud metadata, RFC1918, encodings, IPv6', () => {
  const NEVER_CALLED = async (): Promise<Response> => {
    throw new Error('fetchImpl must never be called for a blocked address')
  }

  async function expectBlocked(rawUrl: string, deps: FetchRemoteAssetDeps = {}) {
    const result = await fetchRemoteAsset(dir, rawUrl, undefined, { fetchImpl: NEVER_CALLED, ...deps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Never echoes a resolved/internal IP or connection detail back to the caller.
    expect(result.error).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
    expect(result.error).not.toContain('::')
    expect(fs.existsSync(path.join(dir, 'src/assets'))).toBe(false)
  }

  it('blocks loopback via literal IP', async () => {
    await expectBlocked('http://127.0.0.1:8080/_studio/mcp')
  })

  it('blocks loopback beyond 127.0.0.1 (the whole 127.0.0.0/8 range)', async () => {
    await expectBlocked('http://127.5.5.5/')
  })

  it('blocks the unspecified address', async () => {
    await expectBlocked('http://0.0.0.0/')
  })

  it('blocks cloud instance metadata (169.254.169.254)', async () => {
    await expectBlocked('http://169.254.169.254/latest/meta-data/')
  })

  it('blocks 10.0.0.0/8', async () => {
    await expectBlocked('http://10.0.0.1/')
  })

  it('blocks 172.16.0.0/12', async () => {
    await expectBlocked('http://172.16.5.1/')
    await expectBlocked('http://172.31.255.255/')
  })

  it('blocks 192.168.0.0/16', async () => {
    await expectBlocked('http://192.168.1.1/')
  })

  it('blocks CGNAT (100.64.0.0/10)', async () => {
    await expectBlocked('http://100.64.0.1/')
  })

  it('blocks IPv6 loopback', async () => {
    await expectBlocked('http://[::1]/')
  })

  it('blocks IPv6 unique-local and link-local', async () => {
    await expectBlocked('http://[fc00::1]/')
    await expectBlocked('http://[fe80::1]/')
  })

  it('blocks an IPv4-mapped IPv6 loopback literal', async () => {
    await expectBlocked('http://[::ffff:127.0.0.1]/')
  })

  it('blocks a decimal-encoded IPv4 loopback literal (2130706433 === 127.0.0.1)', async () => {
    await expectBlocked('http://2130706433/')
  })

  it('blocks an octal-encoded IPv4 loopback literal (017700000001 === 127.0.0.1)', async () => {
    await expectBlocked('http://017700000001/')
  })

  it('blocks a hex-encoded IPv4 loopback literal (0x7f000001 === 127.0.0.1)', async () => {
    await expectBlocked('http://0x7f000001/')
  })

  it('blocks a short-form IPv4 loopback literal (127.1 === 127.0.0.1)', async () => {
    await expectBlocked('http://127.1/')
  })

  it('rejects DNS rebinding: a hostname that resolves to a private address at validation time', async () => {
    await expectBlocked('https://attacker-controlled.example.net/asset.png', {
      resolveHostAddresses: async (host) => (host === 'attacker-controlled.example.net' ? ['10.0.0.5'] : [PUBLIC_IP]),
    })
  })

  it('rejects a hostname that resolves to a mix of public and private addresses (conservative: any bad address blocks all)', async () => {
    await expectBlocked('https://multi-homed.example.net/asset.png', {
      resolveHostAddresses: async () => [PUBLIC_IP, '192.168.50.50'],
    })
  })

  it('rejects a hostname that does not resolve at all, without leaking DNS internals', async () => {
    const result = await fetchRemoteAsset(dir, 'https://nowhere.invalid/asset.png', undefined, {
      fetchImpl: NEVER_CALLED,
      resolveHostAddresses: async () => [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).not.toMatch(/ENOTFOUND|EAI_AGAIN|SERVFAIL/)
  })

  it('pins the connection to a validated public address for a domain name, never re-resolving inside fetchImpl', async () => {
    let seenUrl: string | undefined
    const result = await fetchRemoteAsset(dir, 'https://cdn.example.com/x.png', undefined, {
      fetchImpl: async (input) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        return okResponse(PNG_BYTES)
      },
      resolveHostAddresses: publicResolver(),
    })
    expect(result.ok).toBe(true)
    expect(seenUrl).toContain(PUBLIC_IP)
  })
})
