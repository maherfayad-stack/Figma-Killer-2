/**
 * archiveIngest.ts + studio/importUpload.ts — adversarial tests for the
 * shared ingest engine (WS-1.1). The refusals ARE the feature: every test
 * here drives a hostile input and asserts the rejection, not the happy path.
 *
 * Also asserts the point of the refactor: `studioGithubImport.ts` no longer
 * carries its own copy of the per-entry decision helpers, and the GitHub
 * route + the upload route reject the exact same adversarial entry name
 * through the exact same function.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  ArchiveIngestError,
  createArchiveEntryDecider,
  isSafeRelPath,
  MAX_IMPORT_TOTAL_BYTES,
  readBytesWithLimit,
  readFormDataWithLimit,
  refuseIfStudioWorkspace,
  resolveZipEntryRelPath,
  writeArchiveToWorkspace,
} from '../studio/archiveIngest'
import { detectSharedZipRoot, tryServeStudioIngest } from '../studio/importUpload'
import { runGithubImport } from '../studioGithubImport'
import { WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_FILES } from '@core/page-parser'

// ---------------------------------------------------------------------------
// isSafeRelPath
// ---------------------------------------------------------------------------

describe('isSafeRelPath', () => {
  it('accepts a plain nested path', () => {
    expect(isSafeRelPath('pages/Home.tsx')).toBe(true)
  })

  it('rejects an absolute path', () => {
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
  })

  it('rejects a path containing a literal backslash', () => {
    expect(isSafeRelPath('pages\\Home.tsx')).toBe(false)
  })

  it('rejects a `..` segment', () => {
    expect(isSafeRelPath('../../.ssh/config')).toBe(false)
  })

  it('rejects a `.` segment', () => {
    expect(isSafeRelPath('./pages/Home.tsx')).toBe(false)
  })

  it('rejects an empty segment (double slash)', () => {
    expect(isSafeRelPath('pages//Home.tsx')).toBe(false)
  })

  it('rejects a Windows drive-letter-shaped segment', () => {
    expect(isSafeRelPath('C:/Users/x')).toBe(false)
  })

  it('rejects every EXCLUDED_WORKSPACE_DIR_NAMES entry anywhere in the path', () => {
    expect(isSafeRelPath('node_modules/x/index.js')).toBe(false)
    expect(isSafeRelPath('.git/HEAD')).toBe(false)
    expect(isSafeRelPath('.studio/boards.json')).toBe(false)
    expect(isSafeRelPath('dist/index.js')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveZipEntryRelPath
// ---------------------------------------------------------------------------

describe('resolveZipEntryRelPath', () => {
  describe('stripRootFolder: true (GitHub zipball shape)', () => {
    it('strips the archive root folder', () => {
      expect(resolveZipEntryRelPath('acme-widgets-abc123/pages/Home.tsx', { stripRootFolder: true })).toBe(
        'pages/Home.tsx',
      )
    })

    it('skips a directory entry', () => {
      expect(resolveZipEntryRelPath('acme-widgets-abc123/pages/', { stripRootFolder: true })).toBeNull()
    })

    it('skips the root folder entry itself', () => {
      expect(resolveZipEntryRelPath('acme-widgets-abc123/', { stripRootFolder: true })).toBeNull()
    })

    it('skips an entry with no root folder at all', () => {
      expect(resolveZipEntryRelPath('README.md', { stripRootFolder: true })).toBeNull()
    })

    it('rejects POSIX path traversal (../../.ssh/config)', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/../../.ssh/config', { stripRootFolder: true }),
      ).toBeNull()
    })

    it('rejects Windows-style traversal (..\\..\\windows\\system32)', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/..\\..\\windows\\system32\\evil.dll', {
          stripRootFolder: true,
        }),
      ).toBeNull()
    })

    it('rejects an excluded directory anywhere in the path', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/node_modules/x/index.js', { stripRootFolder: true }),
      ).toBeNull()
      expect(resolveZipEntryRelPath('acme-widgets-abc123/.git/HEAD', { stripRootFolder: true })).toBeNull()
    })

    it('scopes to a subdir, stripping it from the result', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/apps/web/src/App.tsx', {
          stripRootFolder: true,
          subdir: 'apps/web',
        }),
      ).toBe('src/App.tsx')
    })

    it('skips an entry outside the requested subdir', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/apps/other/index.ts', {
          stripRootFolder: true,
          subdir: 'apps/web',
        }),
      ).toBeNull()
    })

    it('rejects an unsafe subdir', () => {
      expect(
        resolveZipEntryRelPath('acme-widgets-abc123/a/b.ts', { stripRootFolder: true, subdir: '../evil' }),
      ).toBeNull()
    })
  })

  describe('stripRootFolder: false (directory-upload shape — client already stripped)', () => {
    it('accepts an already-relative path as-is', () => {
      expect(resolveZipEntryRelPath('pages/Home.tsx', { stripRootFolder: false })).toBe('pages/Home.tsx')
    })

    it('still rejects traversal', () => {
      expect(resolveZipEntryRelPath('../../.ssh/config', { stripRootFolder: false })).toBeNull()
      expect(resolveZipEntryRelPath('..\\..\\windows\\system32\\evil.dll', { stripRootFolder: false })).toBeNull()
    })

    it('still rejects an excluded directory', () => {
      expect(resolveZipEntryRelPath('node_modules/x/index.js', { stripRootFolder: false })).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// createArchiveEntryDecider — budgets
// ---------------------------------------------------------------------------

describe('createArchiveEntryDecider', () => {
  it('rejects a declared 10 GB entry purely on size, no bytes read', () => {
    const decider = createArchiveEntryDecider({ stripRootFolder: false })
    const accepted = decider.decide('huge.bin', 10 * 1024 * 1024 * 1024)
    expect(accepted).toBe(false)
    expect(decider.accepted.size).toBe(0)
    expect(decider.skipped).toBe(1)
  })

  it('rejects a file over the per-file byte cap and keeps accepting smaller ones', () => {
    const decider = createArchiveEntryDecider({ stripRootFolder: false })
    expect(decider.decide('pages/Home.tsx', 100)).toBe(true)
    expect(decider.decide('assets/huge.bin', WORKSPACE_MAX_FILE_BYTES + 1)).toBe(false)
    expect(decider.accepted.size).toBe(1)
    expect(decider.skipped).toBe(1)
  })

  it('rejects once the running total would exceed MAX_IMPORT_TOTAL_BYTES, even though every individual file is under the per-file cap', () => {
    const decider = createArchiveEntryDecider({ stripRootFolder: false })
    // MAX_IMPORT_TOTAL_BYTES (300 MB) is an exact multiple of
    // WORKSPACE_MAX_FILE_BYTES (5 MB) — 60 files right at the per-file cap
    // exactly fill the total budget; the 61st, however tiny, must be
    // rejected on the TOTAL budget alone (a per-file-cap-only guard would
    // wave it through).
    const fileCount = MAX_IMPORT_TOTAL_BYTES / WORKSPACE_MAX_FILE_BYTES
    for (let i = 0; i < fileCount; i++) {
      expect(decider.decide(`chunk-${i}.bin`, WORKSPACE_MAX_FILE_BYTES)).toBe(true)
    }
    expect(decider.accepted.size).toBe(fileCount)
    expect(decider.decide('one-more-byte.bin', 1)).toBe(false)
    expect(decider.skipped).toBe(1)
  })

  it('rejects once the file-count cap (WORKSPACE_MAX_FILES) is reached', () => {
    const decider = createArchiveEntryDecider({ stripRootFolder: false })
    for (let i = 0; i < WORKSPACE_MAX_FILES; i++) {
      expect(decider.decide(`file-${i}.txt`, 1)).toBe(true)
    }
    expect(decider.accepted.size).toBe(WORKSPACE_MAX_FILES)
    expect(decider.decide('one-too-many.txt', 1)).toBe(false)
    expect(decider.skipped).toBe(1)
  })

  it('does not count a silently-skipped entry (traversal) as a budget "skip"', () => {
    const decider = createArchiveEntryDecider({ stripRootFolder: false })
    expect(decider.decide('../../.ssh/config', 10)).toBe(false)
    expect(decider.skipped).toBe(0) // traversal isn't a "skip" — it's just not a shape we ever consider
  })
})

// ---------------------------------------------------------------------------
// refuseIfStudioWorkspace / writeArchiveToWorkspace
// ---------------------------------------------------------------------------

describe('writeArchiveToWorkspace', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-ingest-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses to clear a target that already holds a studio workspace (.studio/ present)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'boards.json'), '{"version":1,"boards":[]}')

    expect(() => refuseIfStudioWorkspace(tmpDir)).toThrow(/existing studio workspace/)

    const accepted = new Map([['a', 'a.txt']])
    await expect(
      writeArchiveToWorkspace(tmpDir, accepted, () => strToU8('hello'), 0),
    ).rejects.toThrow(/existing studio workspace/)
    // The user's board data survived — no partial write happened first.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'boards.json'))).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8')).toContain('"version":1')
  })

  it('rejects with a 400 status via ArchiveIngestError, never a path in the message', async () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    try {
      await writeArchiveToWorkspace(tmpDir, new Map(), () => strToU8(''), 0)
      throw new Error('expected rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(ArchiveIngestError)
      expect((err as ArchiveIngestError).status).toBe(400)
      expect((err as ArchiveIngestError).message).not.toContain(tmpDir)
    }
  })

  it('clears a pre-existing target directory before repopulating it', async () => {
    fs.writeFileSync(path.join(tmpDir, 'stale.txt'), 'leftover from a previous import')
    const accepted = new Map([['entry', 'pages/Home.tsx']])
    await writeArchiveToWorkspace(tmpDir, accepted, () => strToU8('export default function Home(){}'), 0)

    expect(fs.existsSync(path.join(tmpDir, 'stale.txt'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Home.tsx'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readBytesWithLimit / readFormDataWithLimit — never trust content-length
// ---------------------------------------------------------------------------

describe('readBytesWithLimit', () => {
  it('rejects when a spoofed content-length lies UNDER the real streamed size', async () => {
    // The real streamed byte count must be the authority, not the header —
    // a Response whose header claims "small" but whose body actually
    // delivers more than maxBytes must still be capped.
    const realBytes = new Uint8Array(2048)
    const res = new Response(realBytes, { headers: { 'content-length': '10' } })
    await expect(readBytesWithLimit(res, 1024, 'too large')).rejects.toMatchObject({ status: 413 })
  })

  it('rejects a declared content-length over the cap before streaming', async () => {
    const res = new Response(new Uint8Array(1), {
      headers: { 'content-length': String(200 * 1024 * 1024) },
    })
    await expect(readBytesWithLimit(res, 100 * 1024 * 1024, 'too large')).rejects.toMatchObject({
      status: 413,
    })
  })

  it('accepts a body under the cap', async () => {
    const res = new Response(new Uint8Array(10))
    const bytes = await readBytesWithLimit(res, 1024, 'too large')
    expect(bytes.byteLength).toBe(10)
  })
})

describe('readFormDataWithLimit', () => {
  it('rejects an upload whose ACTUAL streamed bytes exceed the cap even with no content-length header', async () => {
    // Bun does not set content-length for a FormData-body Request, so this
    // exercises the true streamed-byte-count enforcement, not the header
    // pre-check.
    const form = new FormData()
    form.set('kind', 'zip')
    form.append('file', new File([new Uint8Array(2048)], 'a.zip'))
    const req = new Request('http://localhost/x', { method: 'POST', body: form })
    expect(req.headers.get('content-length')).toBeNull()

    await expect(readFormDataWithLimit(req, 100)).rejects.toMatchObject({ status: 413 })
  })

  it('parses a well-formed multipart body under the cap', async () => {
    const form = new FormData()
    form.set('kind', 'zip')
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.zip'))
    const req = new Request('http://localhost/x', { method: 'POST', body: form })
    const parsed = await readFormDataWithLimit(req, 10 * 1024 * 1024)
    expect(parsed.get('kind')).toBe('zip')
    expect(parsed.get('file')).toBeInstanceOf(File)
  })
})

// ---------------------------------------------------------------------------
// detectSharedZipRoot
// ---------------------------------------------------------------------------

describe('detectSharedZipRoot', () => {
  it('detects one shared root folder', () => {
    expect(detectSharedZipRoot(['repo-main/pages/Home.tsx', 'repo-main/package.json'])).toBe('repo-main')
  })

  it('returns null when an entry sits at the top level', () => {
    expect(detectSharedZipRoot(['pages/Home.tsx', 'package.json'])).toBeNull()
  })

  it('returns null when entries disagree on the root', () => {
    expect(detectSharedZipRoot(['a/x.ts', 'b/y.ts'])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(detectSharedZipRoot([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// tryServeStudioIngest — end-to-end adversarial tests. `deps.projectsRoot`
// (test-only, mirrors `GithubImportOptions.dir`) points every write at a
// throwaway temp directory — this suite NEVER writes into this repo's real
// `studio-workspace/`.
// ---------------------------------------------------------------------------

describe('tryServeStudioIngest (POST /admin/api/studio/import-upload)', () => {
  let projectsRoot: string

  beforeEach(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-ingest-upload-'))
  })

  afterEach(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true })
  })

  function targetDirFor(rootName: string): string {
    // Mirrors deriveUploadTargetDir's slugification so the test can assert
    // against exactly the directory the route will create.
    const slug = rootName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return path.join(projectsRoot, slug)
  }

  function zipUploadRequest(rootName: string, zipBytes: Uint8Array): Request {
    const form = new FormData()
    form.set('kind', 'zip')
    form.set('rootName', rootName)
    form.append('file', new File([zipBytes], 'upload.zip'))
    return new Request('http://localhost/admin/api/studio/import-upload', { method: 'POST', body: form })
  }

  function serve(req: Request, pathname = '/admin/api/studio/import-upload') {
    return tryServeStudioIngest(req, new URL(req.url), pathname, { projectsRoot })
  }

  it('returns null for a non-matching route (lets the caller try the next sub-router)', async () => {
    const req = new Request('http://localhost/admin/api/studio/other', { method: 'GET' })
    const res = await serve(req, '/admin/api/studio/other')
    expect(res).toBeNull()
  })

  it('rejects a zip entry named ../../.ssh/config — never writes it anywhere', async () => {
    const rootName = `evil-traversal-${Date.now()}`
    const dir = targetDirFor(rootName)
    const zip = zipSync({
      'root/pages/Home.tsx': strToU8('export default function Home(){return null}'),
      'root/../../.ssh/config': strToU8('Host evil\n'),
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.ok).toBe(true)
    expect(body.files).toBe(1)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    // The traversal target must not exist anywhere reachable from the temp root.
    expect(fs.existsSync(path.join(projectsRoot, '.ssh'))).toBe(false)
    expect(fs.existsSync(path.join(process.cwd(), '.ssh'))).toBe(false)
  })

  it('rejects a Windows-style traversal entry (..\\..\\windows\\system32)', async () => {
    const rootName = `evil-windows-traversal-${Date.now()}`
    const dir = targetDirFor(rootName)
    const zip = zipSync({
      'root/pages/Home.tsx': strToU8('export default function Home(){return null}'),
      'root/..\\..\\windows\\system32\\evil.dll': strToU8('MZ'),
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.ok).toBe(true)
    expect(body.files).toBe(1)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('rejects a zip whose every entry lands in node_modules — no importable files', async () => {
    const rootName = `all-node-modules-${Date.now()}`
    const zip = zipSync({
      'root/node_modules/left-pad/index.js': strToU8('module.exports = () => {}'),
      'root/node_modules/.bin/left-pad': strToU8('#!/usr/bin/env node'),
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    expect(res!.status).toBe(422)
    const body = (await res!.json()) as { error: string }
    expect(body.error).toMatch(/no importable files/i)
  })

  it('rejects an upload targeting a directory that already holds .studio/', async () => {
    const rootName = `existing-workspace-${Date.now()}`
    const dir = targetDirFor(rootName)
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.studio', 'boards.json'), '{"version":1,"boards":[]}')

    const zip = zipSync({ 'root/pages/Home.tsx': strToU8('export default function Home(){return null}') })
    const res = await serve(zipUploadRequest(rootName, zip))
    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error: string }
    expect(body.error).toMatch(/existing studio workspace/)
    // No partial write — the user's board data is untouched.
    expect(fs.readFileSync(path.join(dir, '.studio', 'boards.json'), 'utf8')).toContain('"version":1')
  })

  it('accepts a small legitimate upload with no content-length header (streamed-byte-count path only)', async () => {
    // Bun does not set content-length for a FormData-body Request (verified
    // in the `readFormDataWithLimit` suite above), so this exercises the
    // route purely through the streamed-byte-count cap, never the header
    // pre-check — the over-cap case is covered directly against
    // `readFormDataWithLimit` there, without needing a real 100 MB fixture.
    const rootName = `no-content-length-${Date.now()}`
    const zip = zipSync({ 'root/pages/Home.tsx': strToU8('x'.repeat(1024)) })
    const req = zipUploadRequest(rootName, zip)
    expect(req.headers.get('content-length')).toBeNull()
    const res = await serve(req)
    expect(res!.status).toBe(200)
  })

  it('skips a file over the per-file size cap and still imports the rest', async () => {
    const rootName = `oversized-file-${Date.now()}`
    const dir = targetDirFor(rootName)
    const oversized = new Uint8Array(WORKSPACE_MAX_FILE_BYTES + 1)
    const zip = zipSync({
      'root/pages/Home.tsx': strToU8('export default function Home(){return null}'),
      'root/assets/huge.bin': oversized,
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    const body = (await res!.json()) as { ok: boolean; files: number; skipped: number }
    expect(body.files).toBe(1)
    expect(body.skipped).toBe(1)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'assets', 'huge.bin'))).toBe(false)
  })

  it('auto-detects and strips a GitHub-style shared root folder in an uploaded zip', async () => {
    const rootName = `shared-root-${Date.now()}`
    const dir = targetDirFor(rootName)
    const zip = zipSync({
      'someuser-somerepo-abc123/pages/Home.tsx': strToU8('export default function Home(){return null}'),
      'someuser-somerepo-abc123/package.json': strToU8('{}'),
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.files).toBe(2)
    // The shared root was stripped — files land directly under the target, not nested one level deeper.
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'someuser-somerepo-abc123'))).toBe(false)
  })

  it('does NOT strip a root when entries do not share one common top-level folder', async () => {
    const rootName = `no-shared-root-${Date.now()}`
    const dir = targetDirFor(rootName)
    const zip = zipSync({
      'pages/Home.tsx': strToU8('export default function Home(){return null}'),
      'package.json': strToU8('{}'),
    })
    const res = await serve(zipUploadRequest(rootName, zip))
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.files).toBe(2)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
  })

  it('derives the target folder from rootName when omitted (auto-named)', async () => {
    const zip = zipSync({ 'pages/Home.tsx': strToU8('export default function Home(){return null}') })
    const form = new FormData()
    form.set('kind', 'zip')
    form.append('file', new File([zip], 'upload.zip'))
    const req = new Request('http://localhost/admin/api/studio/import-upload', { method: 'POST', body: form })
    const res = await serve(req)
    const body = (await res!.json()) as { ok: boolean; dir: string }
    expect(body.ok).toBe(true)
    expect(body.dir.startsWith(projectsRoot)).toBe(true)
    expect(fs.existsSync(body.dir)).toBe(true)
    expect(fs.existsSync(path.join(body.dir, '.studio', 'meta.json'))).toBe(true)
  })

  it('directory upload: rejects a traversal-shaped filename and imports the rest', async () => {
    const rootName = `dir-upload-traversal-${Date.now()}`
    const dir = targetDirFor(rootName)
    const form = new FormData()
    form.set('kind', 'directory')
    form.set('rootName', rootName)
    form.append('file', new File([strToU8('export default function Home(){return null}')], 'ignored'), 'pages/Home.tsx')
    form.append('file', new File([strToU8('evil')], 'ignored'), '../../.ssh/config')
    const req = new Request('http://localhost/admin/api/studio/import-upload', { method: 'POST', body: form })
    const res = await serve(req)
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.files).toBe(1)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('directory upload: rejects a Windows-style traversal-shaped filename', async () => {
    const rootName = `dir-upload-win-traversal-${Date.now()}`
    const dir = targetDirFor(rootName)
    const form = new FormData()
    form.set('kind', 'directory')
    form.set('rootName', rootName)
    form.append('file', new File([strToU8('export default function Home(){return null}')], 'ignored'), 'pages/Home.tsx')
    form.append('file', new File([strToU8('evil')], 'ignored'), '..\\..\\windows\\system32\\evil.dll')
    const req = new Request('http://localhost/admin/api/studio/import-upload', { method: 'POST', body: form })
    const res = await serve(req)
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.files).toBe(1)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('directory upload: happy path lands every file at the given relative path', async () => {
    const rootName = `dir-upload-happy-${Date.now()}`
    const dir = targetDirFor(rootName)
    const form = new FormData()
    form.set('kind', 'directory')
    form.set('rootName', rootName)
    form.append('file', new File([strToU8('export default function Home(){return null}')], 'ignored'), 'pages/Home.tsx')
    form.append('file', new File([strToU8('{}')], 'ignored'), 'package.json')
    const req = new Request('http://localhost/admin/api/studio/import-upload', { method: 'POST', body: form })
    const res = await serve(req)
    const body = (await res!.json()) as { ok: boolean; files: number }
    expect(body.files).toBe(2)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Both routes share ONE decision function — the point of the refactor.
// ---------------------------------------------------------------------------

describe('shared decision function across both import routes', () => {
  it('studioGithubImport.ts no longer exports its own copy of the decision helpers', async () => {
    const mod: Record<string, unknown> = await import('../studioGithubImport')
    expect(mod.resolveZipEntryRelPath).toBeUndefined()
    expect(mod.isSafeRelPath).toBeUndefined()
  })

  it('rejects the identical adversarial entry name whether it arrives via GitHub or via upload', async () => {
    const evilName = '../../.ssh/config'
    const githubDecider = createArchiveEntryDecider({ stripRootFolder: true })
    const uploadDecider = createArchiveEntryDecider({ stripRootFolder: false })
    expect(githubDecider.decide(`repo-sha/${evilName}`, 10)).toBe(false)
    expect(uploadDecider.decide(evilName, 10)).toBe(false)
  })

  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-ingest-github-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runGithubImport (fetch strategy) and writeArchiveToWorkspace (upload strategy) both refuse a .studio/ target', async () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    const zip = zipSync({ 'repo-sha/pages/Home.tsx': strToU8('export default function Home(){return null}') })
    const fetchImpl = (async () =>
      new Response(zip, { headers: { 'content-length': String(zip.byteLength) } })) as typeof fetch

    await expect(
      runGithubImport({ url: 'https://github.com/acme/widgets', dir: tmpDir }, { fetchImpl }),
    ).rejects.toThrow(/existing studio workspace/)
  })
})
