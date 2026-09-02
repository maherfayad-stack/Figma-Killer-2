/**
 * `studio_list_files` — the tool whose absence made agents guess.
 *
 * With no shell and no directory listing, an agent could only probe
 * `studio_read_file` with invented paths and read the same generic
 * "does not exist" for every one. Observed doing exactly that for a dozen
 * consecutive calls (`pages/sign-in.tsx`, `pages/sign-in/index.tsx`,
 * `README.md`, `CLAUDE.md`, a folder path) while the real file was
 * `pages/SignIn.tsx`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { studioProjectMcpTools } from './projectTools'

const listFiles = studioProjectMcpTools.find((t) => t.name === 'studio_list_files')!
const readFile = studioProjectMcpTools.find((t) => t.name === 'studio_read_file')!

let dir: string

function write(rel: string, body = 'x'): void {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'list-files-'))
  write('pages/SignIn.tsx')
  write('pages/SignIn.module.css')
  write('styles/imported/ds/colors.css')
  write('node_modules/pkg/index.js')
  write('.studio/meta.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('studio_list_files', () => {
  it('lists the whole project as relative POSIX paths', async () => {
    const r = await listFiles.handler!({ dir }, {} as never) as { ok: boolean; files: string[] }
    expect(r.ok).toBe(true)
    expect(r.files).toContain('pages/SignIn.tsx')
    expect(r.files).toContain('styles/imported/ds/colors.css')
  })

  it('never lists dependency or Studio-internal folders', async () => {
    const r = await listFiles.handler!({ dir }, {} as never) as { files: string[] }
    // Same exclusion list every other workspace walk uses — not a second policy.
    expect(r.files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(r.files.some((f) => f.startsWith('.studio/'))).toBe(false)
  })

  it('scopes to one folder when given a path', async () => {
    const r = await listFiles.handler!({ dir, path: 'pages' }, {} as never) as { files: string[] }
    expect(r.files).toEqual(['pages/SignIn.module.css', 'pages/SignIn.tsx'])
  })

  it('says so plainly when a path matches nothing, instead of returning an empty success', async () => {
    const r = await listFiles.handler!({ dir, path: 'nope' }, {} as never) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('matches no files')
  })

  it('reports truncation rather than silently cutting the list', async () => {
    const r = await listFiles.handler!({ dir, limit: 1 }, {} as never) as { files: string[]; total: number; truncated: boolean }
    expect(r.files).toHaveLength(1)
    expect(r.truncated).toBe(true)
    expect(r.total).toBeGreaterThan(1)
  })
})

describe('studio_read_file — errors that tell the caller what to do next', () => {
  it('names a directory as a directory and points at studio_list_files', async () => {
    const r = await readFile.handler!({ dir, path: 'pages' }, {} as never) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('is a directory')
    expect(r.error).toContain('studio_list_files')
  })

  it('points a wrong-case guess at the listing tool rather than leaving it to probe again', async () => {
    // The real file is pages/SignIn.tsx — this is the guess that was observed.
    const r = await readFile.handler!({ dir, path: 'pages/sign-in.tsx' }, {} as never) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('studio_list_files')
  })
})
