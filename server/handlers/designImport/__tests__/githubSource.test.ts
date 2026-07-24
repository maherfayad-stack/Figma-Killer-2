import { describe, expect, it } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { fetchGithubCssSource } from '../githubSource'
import { DesignImportError } from '../shared'

/** Builds a fake GitHub-shaped zipball: everything nested under one root folder, mirroring `studioGithubImport.test.ts`'s helper. */
function buildFakeZipball(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [relPath, contents] of Object.entries(files)) {
    input[`acme-widgets-abcdef1/${relPath}`] = strToU8(contents)
  }
  return zipSync(input)
}

function fakeZipResponse(bytes: Uint8Array, init: { status?: number } = {}): Response {
  return new Response(bytes, { status: init.status ?? 200, headers: { 'content-length': String(bytes.byteLength) } })
}

describe('fetchGithubCssSource', () => {
  it('fetches the zipball and returns only the .css files', async () => {
    const zip = buildFakeZipball({
      'styles/tokens.css': ':root { --brand: #4f46e5; }',
      'src/App.tsx': 'export default function App() { return null }',
      'styles/reset.css': '* { margin: 0; }',
    })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    const result = await fetchGithubCssSource({ url: 'https://github.com/acme/widgets' }, { fetchImpl })

    expect(result.label).toBe('acme/widgets')
    expect(result.cssFiles.map((f) => f.relPath).sort()).toEqual(['styles/reset.css', 'styles/tokens.css'])
    expect(result.cssFiles.find((f) => f.relPath === 'styles/tokens.css')?.contents).toContain('--brand')
  })

  it('rejects an invalid GitHub URL with 400', async () => {
    await expect(fetchGithubCssSource({ url: 'not-a-url' })).rejects.toMatchObject({ status: 400 })
  })

  it('maps a 404 from GitHub to a DesignImportError with status 404', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch
    await expect(
      fetchGithubCssSource({ url: 'https://github.com/acme/widgets' }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 422 when the repo has no .css files', async () => {
    const zip = buildFakeZipball({ 'src/App.tsx': 'export default function App() { return null }' })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch
    await expect(
      fetchGithubCssSource({ url: 'https://github.com/acme/widgets' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(DesignImportError)
  })

  it('scopes to subdir when given', async () => {
    const zip = buildFakeZipball({
      'packages/tokens/colors.css': ':root { --a: red; }',
      'packages/other/colors.css': ':root { --b: blue; }',
    })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    const result = await fetchGithubCssSource(
      { url: 'https://github.com/acme/widgets', subdir: 'packages/tokens' },
      { fetchImpl },
    )

    expect(result.cssFiles.map((f) => f.relPath)).toEqual(['colors.css'])
  })

  it('routes a token-named JSON/TS file into tokenFiles, not cssFiles, and ignores an unrelated JSON file', async () => {
    const zip = buildFakeZipball({
      'styles/base.css': ':root { --a: red; }',
      'tokens.json': JSON.stringify({ brand: '#fff' }),
      'src/colorTokens.ts': `export const c = { brand: '#000' }`,
      'package.json': '{"name":"acme-widgets"}',
    })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    const result = await fetchGithubCssSource({ url: 'https://github.com/acme/widgets' }, { fetchImpl })

    expect(result.cssFiles.map((f) => f.relPath)).toEqual(['styles/base.css'])
    expect(result.tokenFiles.map((f) => f.relPath).sort()).toEqual(['src/colorTokens.ts', 'tokens.json'])
  })
})
