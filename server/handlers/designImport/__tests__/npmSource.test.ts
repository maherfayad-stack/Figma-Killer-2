import { describe, expect, it } from 'bun:test'
import { gzipSync } from 'fflate'
import { fetchNpmCssSource, parseNpmPackageSpec } from '../npmSource'
import { DesignImportError } from '../shared'

describe('parseNpmPackageSpec', () => {
  it('parses a bare package name with no version', () => {
    expect(parseNpmPackageSpec('open-props')).toEqual({ name: 'open-props' })
  })

  it('parses name@version', () => {
    expect(parseNpmPackageSpec('open-props@1.7.0')).toEqual({ name: 'open-props', version: '1.7.0' })
  })

  it('parses a scoped package with no version, keeping the leading @ as part of the scope', () => {
    expect(parseNpmPackageSpec('@radix-ui/colors')).toEqual({ name: '@radix-ui/colors' })
  })

  it('parses a scoped package with a version, splitting on the SECOND @', () => {
    expect(parseNpmPackageSpec('@radix-ui/colors@3.0.0')).toEqual({ name: '@radix-ui/colors', version: '3.0.0' })
  })

  it('returns null for an empty string', () => {
    expect(parseNpmPackageSpec('  ')).toBeNull()
  })

  it('returns null for a scope with no package name', () => {
    expect(parseNpmPackageSpec('@radix-ui')).toBeNull()
  })

  it('returns null for a trailing empty version', () => {
    expect(parseNpmPackageSpec('open-props@')).toBeNull()
  })
})

const BLOCK_SIZE = 512

function buildHeader(name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE)
  const encoder = new TextEncoder()
  block.set(encoder.encode(name).subarray(0, 100), 0)
  block.set(encoder.encode(size.toString(8).padStart(11, '0') + '\0'), 124)
  block.set(encoder.encode('0'), 156)
  return block
}

function pad(bytes: Uint8Array): Uint8Array {
  const paddedLen = Math.ceil(bytes.length / BLOCK_SIZE) * BLOCK_SIZE
  const out = new Uint8Array(paddedLen)
  out.set(bytes, 0)
  return out
}

/** Builds a fake npm-shaped `.tgz`: gzip(tar(entries)), each entry under the conventional `package/` root folder. */
function buildFakeNpmTarball(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, contents] of Object.entries(entries)) {
    const contentBytes = encoder.encode(contents)
    parts.push(buildHeader(`package/${name}`, contentBytes.byteLength))
    parts.push(pad(contentBytes))
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2))
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const tar = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { tar.set(part, offset); offset += part.byteLength }
  return gzipSync(tar)
}

describe('fetchNpmCssSource', () => {
  it('resolves the latest version, fetches the tarball, and returns every .css file', async () => {
    const tarball = buildFakeNpmTarball({
      'index.css': ':root { --brand: #4f46e5; }',
      'reset.css': '* { margin: 0; }',
      'README.md': '# not css',
    })

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://registry.npmjs.org/')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: 'https://example.test/pkg-1.0.0.tgz' } } },
          }),
          { status: 200 },
        )
      }
      if (url === 'https://example.test/pkg-1.0.0.tgz') {
        return new Response(tarball, { status: 200, headers: { 'content-length': String(tarball.byteLength) } })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const result = await fetchNpmCssSource({ packageSpec: 'fake-pkg' }, { fetchImpl })

    expect(result.label).toBe('fake-pkg@1.0.0')
    expect(result.cssFiles.map((f) => f.relPath).sort()).toEqual(['index.css', 'reset.css'])
    expect(result.cssFiles.find((f) => f.relPath === 'index.css')?.contents).toContain('--brand')
  })

  it('throws a 404 DesignImportError when the package is not found', async () => {
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as typeof fetch

    await expect(fetchNpmCssSource({ packageSpec: 'does-not-exist' }, { fetchImpl })).rejects.toMatchObject({
      status: 404,
    })
  })

  it('throws a 400 DesignImportError for an invalid package spec', async () => {
    await expect(fetchNpmCssSource({ packageSpec: '  ' })).rejects.toBeInstanceOf(DesignImportError)
  })

  it('throws a 404 when the requested version does not exist', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://registry.npmjs.org/')) {
        return new Response(
          JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'x' } } } }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await expect(
      fetchNpmCssSource({ packageSpec: 'fake-pkg@9.9.9' }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws a 422 when the package has no .css files', async () => {
    const tarball = buildFakeNpmTarball({ 'index.js': 'console.log(1)' })
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://registry.npmjs.org/')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: 'https://example.test/pkg-1.0.0.tgz' } } },
          }),
          { status: 200 },
        )
      }
      return new Response(tarball, { status: 200 })
    }) as typeof fetch

    await expect(fetchNpmCssSource({ packageSpec: 'no-css-pkg' }, { fetchImpl })).rejects.toMatchObject({
      status: 422,
    })
  })
})
