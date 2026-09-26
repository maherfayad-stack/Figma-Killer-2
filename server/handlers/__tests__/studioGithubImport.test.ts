/**
 * studioGithubImport.ts — unit tests for the pure GitHub-URL helpers
 * (Phase 7B), plus `runGithubImport` exercised end-to-end against an
 * in-memory zip and a stubbed `fetchImpl` — no real network calls.
 *
 * The zip-entry decision helpers (`resolveZipEntryRelPath`, `isSafeRelPath`)
 * moved to `studio/archiveIngest.ts` (WS-1.1 — one shared ingest engine for
 * both the GitHub and upload import routes); their tests moved to
 * `archiveIngest.test.ts`. This file keeps only what's genuinely
 * GitHub-specific.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import {
  buildGithubZipballUrl,
  defaultGithubImportDir,
  GithubImportError,
  parseGithubRepoUrl,
  runGithubImport,
} from '../studioGithubImport'
import { parseGithubRemoteUrl } from '../studio/gitPaths'
import { projectsRootDir } from '../studioProjects'

describe('parseGithubRepoUrl', () => {
  it('parses a plain repo URL', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/widgets')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('strips a trailing .git suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('tolerates a trailing slash', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/widgets/')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('ignores extra path segments (branch/subpath views)', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/widgets/tree/main/src')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('accepts www.github.com', () => {
    expect(parseGithubRepoUrl('https://www.github.com/acme/widgets')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('rejects a non-GitHub host', () => {
    expect(parseGithubRepoUrl('https://gitlab.com/acme/widgets')).toBeNull()
  })

  it('rejects a URL missing the repo segment', () => {
    expect(parseGithubRepoUrl('https://github.com/acme')).toBeNull()
  })

  it('rejects a non-URL string', () => {
    expect(parseGithubRepoUrl('not a url')).toBeNull()
  })

  it('rejects a non-http(s) protocol', () => {
    expect(parseGithubRepoUrl('ftp://github.com/acme/widgets')).toBeNull()
  })

  it('rejects an owner/repo with unsafe characters', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/wid$gets')).toBeNull()
  })

  /**
   * The zipball import shares the git routes' owner/repo judgement
   * (`studio/gitPaths.ts`) rather than keeping its own charset copy, so the
   * two cannot disagree about what a repository is called. These drive the
   * rules the charset alone never had (`sec-13`).
   */
  it('rejects a dots-only owner or repo, and a name GitHub could never issue', () => {
    for (const hostile of [
      'https://github.com/./widgets',
      'https://github.com/acme/..',
      'https://github.com/acme/.',
      'https://github.com/%2e%2e/widgets',
      'https://github.com/-acme/widgets',
      'https://github.com/acme-/widgets',
      'https://github.com/acme/-widgets',
      `https://github.com/${'a'.repeat(40)}/widgets`,
      `https://github.com/acme/${'a'.repeat(101)}`,
    ]) {
      expect(parseGithubRepoUrl(hostile)).toBeNull()
    }
  })

  /**
   * `parseGithubRemoteUrl` has refused userinfo since G2 — it persists a
   * credential into `.git/config`. This parser accepted it and silently
   * dropped it, which is the worse failure of the two for the user: the
   * zipball fetch is built from the parsed owner/repo and authenticates from
   * the request body's own `token`, so a pasted
   * `https://ghp_…@github.com/acme/private` went out unauthenticated and came
   * back "not found" for a repository that exists. Both forms refuse it now.
   */
  it('rejects a URL carrying userinfo, exactly as the git routes do', () => {
    for (const hostile of [
      'https://ghp_0123456789abcdef@github.com/acme/widgets',
      'https://user:pass@github.com/acme/widgets',
      'https://user@github.com/acme/widgets',
      'https://:pass@github.com/acme/widgets',
    ]) {
      expect(parseGithubRepoUrl(hostile)).toBeNull()
      expect(parseGithubRemoteUrl(hostile)).toBeNull()
    }
    // The same URL without the credential is still accepted.
    expect(parseGithubRepoUrl('https://github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('still accepts `.github`, dotted and underscored names, and the exact ceilings', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/.github')).toEqual({ owner: 'acme', repo: '.github' })
    expect(parseGithubRepoUrl('https://github.com/my_org/socket.io')).toEqual({ owner: 'my_org', repo: 'socket.io' })
    expect(parseGithubRepoUrl(`https://github.com/${'a'.repeat(39)}/${'b'.repeat(100)}`)).toEqual({
      owner: 'a'.repeat(39),
      repo: 'b'.repeat(100),
    })
  })
})

describe('buildGithubZipballUrl', () => {
  it('defaults to HEAD (the API resolves this to the default branch)', () => {
    expect(buildGithubZipballUrl('acme', 'widgets')).toBe(
      'https://api.github.com/repos/acme/widgets/zipball/HEAD',
    )
  })

  it('uses the given ref', () => {
    expect(buildGithubZipballUrl('acme', 'widgets', 'v2')).toBe(
      'https://api.github.com/repos/acme/widgets/zipball/v2',
    )
  })

  it('URL-encodes an unusual ref', () => {
    expect(buildGithubZipballUrl('acme', 'widgets', 'feature/x')).toBe(
      'https://api.github.com/repos/acme/widgets/zipball/feature%2Fx',
    )
  })
})

describe('defaultGithubImportDir', () => {
  let previousRoot: string | undefined
  let root: string

  beforeEach(() => {
    previousRoot = process.env.STUDIO_WORKSPACE_DIR
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gh-import-root-'))
    process.env.STUDIO_WORKSPACE_DIR = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
    else process.env.STUDIO_WORKSPACE_DIR = previousRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('is scoped to its own repo folder directly under the workspace root, never the root itself', () => {
    const dir = defaultGithubImportDir('acme', 'widgets')
    expect(dir).toBe(path.join(projectsRootDir(), 'acme-widgets'))
    expect(dir).not.toBe(projectsRootDir())
  })

  // P1-H regression: the import target was `<cwd>/studio-workspace/<owner>-<repo>`
  // no matter what `STUDIO_WORKSPACE_DIR` said. A deployed image points that
  // variable at its persistent volume, so every GitHub import landed OUTSIDE
  // the volume (lost on the next container recreate) and outside the root the
  // launcher lists (so the imported project never even appeared).
  it('follows STUDIO_WORKSPACE_DIR, so an import lands on the relocated (persistent) root', () => {
    const dir = defaultGithubImportDir('acme', 'widgets')
    expect(path.dirname(dir)).toBe(path.resolve(root))
    expect(dir.startsWith(path.join(process.cwd(), 'studio-workspace'))).toBe(false)
  })
})

/** Builds a fake GitHub-shaped zipball: everything nested under one root folder. */
function buildFakeZipball(files: Record<string, string | Uint8Array>): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [relPath, contents] of Object.entries(files)) {
    input[`acme-widgets-abcdef1/${relPath}`] = typeof contents === 'string' ? strToU8(contents) : contents
  }
  return zipSync(input)
}

function fakeZipResponse(bytes: Uint8Array, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return new Response(bytes, { status, headers: { 'content-length': String(bytes.byteLength) } })
}

describe('runGithubImport', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-github-import-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects a bad URL before ever calling fetch', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      throw new Error('should not be called')
    }) as typeof fetch

    await expect(
      runGithubImport({ url: 'not-a-url', dir: tmpDir }, { fetchImpl }),
    ).rejects.toThrow(GithubImportError)
    expect(called).toBe(false)
  })

  it('fetches the zipball, writes matching files, and reports the count', async () => {
    const zip = buildFakeZipball({
      'pages/Home.tsx': 'export default function Home() { return null }',
      'package.json': '{}',
    })

    let requestedUrl: string | undefined
    let requestedHeaders: Record<string, string> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requestedUrl = String(url)
      requestedHeaders = init?.headers as Record<string, string>
      return fakeZipResponse(zip)
    }) as typeof fetch

    const result = await runGithubImport(
      { url: 'https://github.com/acme/widgets', token: 'secret-token', dir: tmpDir },
      { fetchImpl },
    )

    expect(requestedUrl).toBe('https://api.github.com/repos/acme/widgets/zipball/HEAD')
    expect(requestedHeaders?.authorization).toBe('Bearer secret-token')
    expect(result).toEqual({ dir: tmpDir, files: 2, skipped: 0 })
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')).toContain('Home')
    expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(true)
  })

  it('refuses to clear a target that is a hand-authored studio workspace (.studio/ present)', async () => {
    // Data-loss guard: `.studio/` marks a real workspace (boards, sticky
    // notes — user data with no other copy). Import must never wipe one, no
    // matter which caller supplied the target.
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'boards.json'), '{"version":1,"boards":[]}')
    const zip = buildFakeZipball({ 'pages/Home.tsx': 'export default function Home() { return null }' })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toThrow(/existing studio workspace/)
    // The user's board data survived.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'boards.json'))).toBe(true)
  })

  it('clears a pre-existing target directory before repopulating it', async () => {
    fs.writeFileSync(path.join(tmpDir, 'stale.txt'), 'leftover from a previous import')
    const zip = buildFakeZipball({ 'pages/Home.tsx': 'export default function Home() { return null }' })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    await runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl })

    expect(fs.existsSync(path.join(tmpDir, 'stale.txt'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('scopes the import to a subdir', async () => {
    const zip = buildFakeZipball({
      'apps/web/pages/Home.tsx': 'export default function Home() { return null }',
      'apps/other/index.ts': 'ignored',
    })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    const result = await runGithubImport(
      { url: 'https://github.com/acme/widgets', subdir: 'apps/web', dir: tmpDir },
      { fetchImpl },
    )

    expect(result.files).toBe(1)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'index.ts'))).toBe(false)
  })

  it('skips a file over the per-file size cap and still imports the rest', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1)
    const zip = buildFakeZipball({
      'pages/Home.tsx': 'export default function Home() { return null }',
      'assets/huge.bin': oversized,
    })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    const result = await runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl })

    expect(result.files).toBe(1)
    expect(result.skipped).toBe(1)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'assets', 'huge.bin'))).toBe(false)
  })

  it('throws a 404 GithubImportError when the repo/ref is not found', async () => {
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws a 403 GithubImportError for an access-denied response', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('wraps a network failure as a 502 GithubImportError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('rejects an archive over the download size cap via content-length', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(1), {
        status: 200,
        headers: { 'content-length': String(200 * 1024 * 1024) },
      })) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('throws when nothing matched (e.g. an empty/mismatched subdir)', async () => {
    const zip = buildFakeZipball({ 'pages/Home.tsx': 'export default function Home() { return null }' })
    const fetchImpl = (async () => fakeZipResponse(zip)) as typeof fetch

    await expect(
      runGithubImport(
        { url: 'https://github.com/acme/widgets', subdir: 'does/not/exist', dir: tmpDir },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ status: 422 })
  })
})
