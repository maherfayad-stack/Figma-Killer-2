/**
 * remoteAssetFetch — the server-side "fetch this URL and land it in the
 * project" step behind `studio_fetch_remote_asset`.
 *
 * Why this exists: `studio_upload_asset`'s `imageBase64` input requires the
 * MODEL to hold the full base64-encoded bytes of whatever it wants to land —
 * fine for something the model generated itself, hopeless for an asset an
 * external MCP tool (a Figma MCP's export/download tool, most concretely)
 * already returned as a URL. Round-tripping a real image's bytes through the
 * model's own context window (tool result in, base64 argument back out) can
 * burn tens of thousands of tokens for one icon and repeats for every asset a
 * turn touches. This tool takes the URL instead — the bytes are fetched here,
 * on the server, and never pass through the model at all.
 *
 * The URL is untrusted input, exactly like a project's own `.mcp.json` entry
 * or a `studio_render_reference` dev-server response — an agent could be
 * fooled or misdirected into supplying one that points somewhere it
 * shouldn't. This process also serves the admin API and the MCP endpoint on
 * loopback, so an unguarded fetch here is a direct SSRF path to Studio
 * itself, to cloud instance metadata, and to every RFC1918 address reachable
 * from this host. Six protections, matching what a URL-taking write path
 * needs:
 *
 *   1. Scheme restricted to `http:`/`https:` — no `file:`, no `data:`, no
 *      internal scheme.
 *   2. **The resolved address is validated, and the connection is pinned to
 *      exactly that address** (`resolveSafeConnectAddress` +
 *      `pinUrlToAddress`) — every address a hostname resolves to (not just
 *      the first) is checked against the shared loopback/private/link-
 *      local/CGNAT/unique-local/metadata blocklist (`server/util/
 *      ssrfGuard.ts`, the same classifier the QuickJS plugin sandbox's
 *      `network.outbound` gate uses), and a literal IP in the URL itself
 *      (decimal/octal/hex encodings included — the platform `URL` parser
 *      canonicalizes those to dotted-decimal before we ever see them) is
 *      checked the same way. The request is then made directly against the
 *      validated address, with the original hostname preserved as the
 *      `Host` header and the TLS `serverName` (SNI) so virtual-hosted/CDN-
 *      fronted targets and certificate validation both keep working. This
 *      is the DNS-rebinding fix: a naive "resolve, check, then let `fetch`
 *      re-resolve the hostname on its own" leaves exactly the TOCTOU gap a
 *      rebinding attack needs. See "Residual risk" below for the honest
 *      limit of how far this goes.
 *   3. No redirect is ever followed (`redirect: 'error'`) — the strict form
 *      of "do not follow redirects to arbitrary hosts": rather than trying to
 *      validate a redirect target's host, no redirect response is accepted
 *      at all. Untouched by protection 2 — a followed redirect would bypass
 *      address pinning entirely, which is exactly why this stays absolute.
 *   4. The response body is capped by STREAMED byte count
 *      (`readBytesWithLimit`, the same primitive the GitHub zipball fetch
 *      uses), not `content-length`.
 *   5. The resulting bytes go through `landAssetBytes`, the exact same
 *      magic-number sniff, SVG sanitization, and containment-checked write
 *      `studio_upload_asset`'s browser upload already uses. This is a second
 *      CALLER of that pipeline, never a second implementation of it.
 *   6. Every user-facing error is a fixed, generic message — never the raw
 *      `Error#message` from a failed connection/DNS lookup, which can carry
 *      resolved IPs, ports, or errno detail. The real cause is logged
 *      server-side (`console.error`) only.
 *
 * Blocklist, not allowlist, and why: the tool's own contract is generic
 * ("another tool... already returned as a URL"), not Figma-specific, and its
 * most predictable real caller (a Figma MCP server's export/download
 * response) still resolves to a shifting, versioned set of S3/CDN hosts
 * (region-sharded buckets, signed-URL subdomains) with no single stable
 * name to allowlist. A hardcoded hostname allowlist would either need
 * constant maintenance against Figma's own infrastructure changes, or be
 * loose enough to be meaningless — and it would silently break every OTHER
 * design-tool MCP server's export/download URL, which is precisely the kind
 * of unhelpful, unexplained lockout this tool must not produce for a
 * legitimate caller. The address-range blocklist plus connection pinning
 * closes the concrete threats in scope (loopback, cloud metadata, RFC1918,
 * rebinding) without coupling a generic tool to one vendor's hosting.
 *
 * Residual risk — stated plainly, not implied away: Bun's global `fetch` has
 * no per-request DNS/connect hook (unlike Node's `http.Agent({ lookup })`),
 * so "resolve once, validate, connect to exactly that address" via URL
 * rewriting is the strongest mitigation reachable without a custom
 * transport. This collapses the rebinding window to nothing for THIS
 * request — no second, attacker-influenced DNS resolution ever happens
 * between validation and connection — but it does not, and cannot, protect
 * against a resolver that is already compromised at the moment
 * `resolveHostAddresses` itself runs (a poisoned OS/network resolver
 * returning a private address disguised as public on the very first
 * lookup). That failure mode is a compromised DNS infrastructure problem,
 * outside what any application-level fetch guard can detect.
 */
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { basename } from 'node:path'
import { ArchiveIngestError, readBytesWithLimit } from './archiveIngest'
import { landAssetBytes, type LandAssetResult } from './assetLanding'
import { isBlockedAddress, stripHostnameBrackets } from '../../util/ssrfGuard'

/** Same order of magnitude as `MAX_ASSET_UPLOAD_BYTES` (`assetUpload.ts`) — a single image has no business exceeding this regardless of transport. */
export const MAX_REMOTE_ASSET_BYTES = 25 * 1024 * 1024 // 25 MB

export interface FetchRemoteAssetDeps {
  /**
   * Byte ceiling for the streamed response body. Defaults to
   * {@link MAX_REMOTE_ASSET_BYTES} (25 MB), which is right for
   * `studio_fetch_remote_asset`'s ordinary "land an icon/image in the repo"
   * job.
   *
   * A design reference is the one caller that legitimately needs more: it is
   * stored LOSSLESS on purpose (it is a measurement baseline — see
   * `designReferenceStore.ts`), and `DESIGN_REFERENCE_MAX_BYTES` is 50 MB
   * because a 3x Figma export of a tall screen really does weigh 15-40 MB.
   * Without this override the two paths disagreed: a user could upload a
   * 40 MB comp through `POST /admin/api/studio/reference-upload` and have it
   * accepted, while an agent registering the SAME file by url failed at
   * 25 MB. Raising the shared constant instead would have quietly loosened
   * `studio_fetch_remote_asset` too, which has no reason to accept a 50 MB
   * icon — hence a per-caller cap rather than one number for both.
   */
  maxBytes?: number
  /**
   * Whether loopback counts as reachable. Defaults to
   * {@link loopbackAssetFetchEnabled}, i.e. the operator's env var.
   *
   * Explicit here so the SSRF tests are HERMETIC. Bun autoloads `.env`, so a
   * developer who legitimately enabled loopback for their own Figma Dev Mode
   * server silently flipped the default under the test suite and five
   * "blocks loopback" assertions began passing a blocked address straight to
   * `fetchImpl`. A guard test that reads the developer's environment is not
   * testing the guard.
   */
  allowLoopback?: boolean
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Test seam — defaults to the system DNS resolver. Must return EVERY
   * address a hostname resolves to (never just one), so every candidate can
   * be checked against the SSRF blocklist; a real rebinding attempt can
   * answer with a mix of public and private records hoping only the first
   * gets checked.
   */
  resolveHostAddresses?: (host: string) => Promise<string[]>
}

export type FetchRemoteAssetResult =
  | { ok: true; relPath: string; bytesWritten: number }
  | { ok: false; error: string }

/** `http:`/`https:` only. Returns `null` for anything else, including an unparseable string — never guesses at intent. */
function validateRemoteAssetUrl(raw: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed
}

/** A filename HINT only — `landAssetBytes` re-derives the real extension from the sniffed bytes regardless of what the URL's path suggests. */
function filenameHintFromUrl(url: URL): string {
  const last = basename(url.pathname)
  return last.length > 0 ? last : 'asset'
}

async function defaultResolveHostAddresses(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true })
    return records.map((record) => record.address)
  } catch {
    return [] // NXDOMAIN / resolver failure — treated as "did not resolve", never surfaced verbatim
  }
}

export type FetchRemoteBytesResult =
  | { ok: true; bytes: Uint8Array; filenameHint: string }
  | { ok: false; error: string }

type SafeAddressResolution =
  | { ok: true; addresses: readonly string[] }
  | { ok: false; reason: 'unresolved' | 'blocked' }

/**
 * Resolves `hostname` to every address it names — a literal IP resolves to
 * itself, a domain name goes through `resolveHostAddresses` — and checks
 * EVERY candidate against the SSRF blocklist before accepting any of them.
 * Returns the single address the request will actually connect to
 * (`pinUrlToAddress`) only when the whole set is clean.
 */
async function resolveSafeConnectAddress(
  hostname: string,
  resolveHostAddresses: (host: string) => Promise<string[]>,
  allowLoopback: boolean,
): Promise<SafeAddressResolution> {
  const host = stripHostnameBrackets(hostname)
  const addresses = isIP(host) !== 0 ? [host] : await resolveHostAddresses(host)
  if (addresses.length === 0) return { ok: false, reason: 'unresolved' }
  for (const address of addresses) {
    if (isBlockedAddress(address, { allowLoopback })) return { ok: false, reason: 'blocked' }
  }
  // EVERY address is returned, not just the first. All of them cleared the
  // blocklist, so connecting to any is equally safe — and pinning blindly to
  // addresses[0] made a host that merely LISTS an address unreachable when
  // nothing is listening on it. Concretely: `localhost` resolves to ::1 first
  // on macOS while the Figma Dev Mode server binds IPv4 only, so every asset
  // fetch failed with ConnectionRefused against an address the server never
  // claimed to serve.
  return { ok: true, addresses }
}

/**
 * Single-machine escape hatch for fetching assets served on loopback.
 *
 * The concrete case is the Figma Dev Mode MCP server: it is the ONLY Figma
 * server a Studio agent gets (`BUILT_IN_MCP_SERVERS`, `127.0.0.1:3845`), and
 * every asset it exposes — the icons, logos and photographs a design is built
 * from, surfaced as download URLs by `get_design_context` — is served from
 * `http://localhost:3845/assets/...`. The SSRF guard blocked that origin, so
 * "the agent cannot download images or SVGs" was a true statement about the
 * product, not a model failure.
 *
 * The trade this makes is real and is the operator's to make: with this on,
 * any URL the agent supplies can reach any service on the host, INCLUDING
 * Studio's own API. On a single-user development machine the agent already
 * acts with that user's authority, so it grants nothing new. On a host serving
 * several people it is a genuine SSRF hole.
 *
 * An env var and not a setting, for the reason `STUDIO_ALLOW_MACOS_CLAUDE_CLI`
 * gives: a setting lives in the database and can be flipped by anyone who
 * reaches the admin UI, while an env var has to be set by whoever starts the
 * process. Off unless explicitly `1` or `true`; anything else — including a
 * typo, `0`, or an empty string — leaves the guard fully closed.
 *
 * Loopback ONLY. RFC1918, CGNAT and link-local (so the 169.254.169.254
 * cloud-metadata address) stay blocked regardless — see `isLoopbackAddress`.
 */
const LOOPBACK_ASSET_FETCH_ENV_VAR = 'STUDIO_ALLOW_LOOPBACK_ASSET_FETCH'

export function loopbackAssetFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LOOPBACK_ASSET_FETCH_ENV_VAR]?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Rewrites `url` so its own literal host is the validated `address` — the
 * connection-pinning half of the SSRF fix. `url.hostname`/`url.host` stay
 * available on the ORIGINAL `url` for the caller to use as the `Host` header
 * and TLS `serverName`, so virtual-hosted / CDN-fronted targets keep
 * resolving to the right vhost even though the literal connection target is
 * now an IP.
 */
function pinUrlToAddress(url: URL, address: string): URL {
  const pinned = new URL(url.toString())
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
  return pinned
}

/**
 * Fetch `rawUrl` server-side and return its validated bytes — the
 * SSRF-hardened half of `fetchRemoteAsset`, split out so a caller that needs
 * the bytes for something other than `landAssetBytes`'s default asset
 * destination (`studio_register_design_reference` landing into
 * `.studio/references` via `designReferenceStore.ts`, concretely) reuses the
 * EXACT same fetch-side safety (scheme restriction, resolved-address
 * pinning, no redirect, streamed size cap) rather than a second
 * implementation of it. Never throws — every failure mode returns
 * `{ ok: false, error }` with a message naming the failure KIND, never
 * internal network detail (a resolved IP, a connect errno) the caller has no
 * business learning.
 */
export async function fetchRemoteBytes(
  rawUrl: string,
  deps: FetchRemoteAssetDeps = {},
): Promise<FetchRemoteBytesResult> {
  const url = validateRemoteAssetUrl(rawUrl)
  if (!url) return { ok: false, error: `"${rawUrl}" is not a valid http:// or https:// URL.` }

  const resolveHostAddresses = deps.resolveHostAddresses ?? defaultResolveHostAddresses
  const resolution = await resolveSafeConnectAddress(
    url.hostname,
    resolveHostAddresses,
    deps.allowLoopback ?? loopbackAssetFetchEnabled(),
  )
  if (!resolution.ok) {
    // Deliberately does NOT echo `rawUrl` here (unlike the other error
    // branches below): for a literal-IP URL the caller already knows what
    // they typed, but for a DOMAIN NAME this branch fires because of what
    // the address RESOLVED to — information the caller does not already
    // have — so the message stays generic regardless of which case it was,
    // rather than have two branches with different leak properties.
    return {
      ok: false,
      error:
        resolution.reason === 'unresolved'
          ? 'That URL\'s host name could not be resolved.'
          : 'That URL points to a host this tool is not allowed to reach.',
    }
  }

  const sniHost = stripHostnameBrackets(url.hostname)
  const fetchImpl = deps.fetchImpl ?? fetch

  // Try each validated address until one CONNECTS. Only a transport failure
  // moves on to the next candidate — an HTTP response, of any status, is the
  // host answering and ends the loop, so a 404 is never retried against a
  // second address.
  let res: Response | null = null
  let lastError: unknown
  for (const address of resolution.addresses) {
    try {
      res = await fetchImpl(pinUrlToAddress(url, address), {
        redirect: 'error',
        headers: { 'user-agent': 'studio-asset-fetch', host: url.host },
        ...(url.protocol === 'https:' ? { tls: { serverName: sniHost } } : {}),
      })
      break
    } catch (err) {
      lastError = err
    }
  }
  if (!res) {
    console.error('[remoteAssetFetch] fetch failed', lastError)
    return {
      ok: false,
      error: `Could not fetch ${rawUrl} (a redirect response is refused outright and never followed).`,
    }
  }
  if (!res.ok) return { ok: false, error: `The remote server returned ${res.status} for ${rawUrl}.` }

  let bytes: Uint8Array
  try {
    const maxBytes = deps.maxBytes ?? MAX_REMOTE_ASSET_BYTES
    bytes = await readBytesWithLimit(
      res,
      maxBytes,
      `The fetched asset is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`,
    )
  } catch (err) {
    if (err instanceof ArchiveIngestError) return { ok: false, error: err.message }
    console.error('[remoteAssetFetch] failed reading response body', err)
    return { ok: false, error: `Could not read the fetched asset.` }
  }

  return { ok: true, bytes, filenameHint: filenameHintFromUrl(url) }
}

/**
 * Fetch `rawUrl` server-side and land the result into `dir`/`targetDir` via
 * `landAssetBytes`. A thin `fetchRemoteBytes` + `landAssetBytes` composition
 * — see `fetchRemoteBytes` for the fetch-side safety reasoning. Never
 * throws; an unrecognized content type or an SVG that sanitizes to nothing
 * surfaces as `{ ok: false, error }` from `landAssetBytes` unchanged.
 */
export async function fetchRemoteAsset(
  dir: string,
  rawUrl: string,
  targetDir: string | undefined,
  deps: FetchRemoteAssetDeps = {},
): Promise<FetchRemoteAssetResult> {
  const fetched = await fetchRemoteBytes(rawUrl, deps)
  if (!fetched.ok) return fetched

  const landed: LandAssetResult = landAssetBytes(dir, targetDir, fetched.bytes, fetched.filenameHint)
  if (!landed.ok) return { ok: false, error: landed.error }
  return { ok: true, relPath: landed.relPath, bytesWritten: fetched.bytes.length }
}
