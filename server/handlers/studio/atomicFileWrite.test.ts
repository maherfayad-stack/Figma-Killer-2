/**
 * writeFileAtomic — an agent write replaces a file in one step (security
 * review of #233, F5): the old text or the new, never a truncated file in
 * between, and on Windows a file another process holds open still gets the
 * write rather than an error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomicFileWrite'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-atomic-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('never leaves the target truncated: at the moment of the swap the old text is still whole', () => {
    const file = join(dir, 'Home.tsx')
    writeFileSync(file, 'OLD CONTENT')
    let seenAtSwap: string | undefined
    writeFileAtomic(file, 'NEW CONTENT', {
      rename: (from, to) => {
        // A reader racing the write — the watcher, Vite, the canvas.
        seenAtSwap = readFileSync(to, 'utf8')
        renameSync(from, to)
      },
    })
    expect(seenAtSwap).toBe('OLD CONTENT')
    expect(readFileSync(file, 'utf8')).toBe('NEW CONTENT')
    expect(readdirSync(dir)).toEqual(['Home.tsx'])
  })

  it('a crash before the swap leaves the old file whole and no temp file behind', () => {
    const file = join(dir, 'Home.tsx')
    writeFileSync(file, 'OLD CONTENT')
    expect(() => writeFileAtomic(file, 'NEW', { rename: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) } })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('OLD CONTENT')
    expect(readdirSync(dir)).toEqual(['Home.tsx'])
  })

  it('a file held open (EPERM on Windows) is retried, then written in place — never lost', () => {
    const file = join(dir, 'Home.tsx')
    writeFileSync(file, 'OLD')
    let attempts = 0
    writeFileAtomic(file, 'NEW', { rename: () => { attempts += 1; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } })
    expect(attempts).toBeGreaterThan(1)
    expect(readFileSync(file, 'utf8')).toBe('NEW')
    expect(readdirSync(dir)).toEqual(['Home.tsx'])
  })

  it('with a real second handle open on the target, the write still lands', () => {
    const file = join(dir, 'Home.tsx')
    writeFileSync(file, 'OLD')
    const fd = openSync(file, 'r')
    try {
      writeFileAtomic(file, 'NEW')
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(file, 'utf8')).toBe('NEW')
    expect(readdirSync(dir)).toEqual(['Home.tsx'])
  })

  it('writes through a symlink to its target, leaving the link a link', () => {
    const real = join(dir, 'real.css')
    const link = join(dir, 'link.css')
    writeFileSync(real, 'a {}')
    try {
      symlinkSync(real, link, 'file')
    } catch {
      return // unprivileged file symlinks are not always available on Windows
    }
    writeFileAtomic(link, 'b {}')
    expect(readFileSync(real, 'utf8')).toBe('b {}')
    expect(statSync(link).isFile()).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it('keeps the permission bits (POSIX)', () => {
    if (process.platform === 'win32') return
    const file = join(dir, 'run.sh')
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    writeFileAtomic(file, '#!/bin/sh\necho hi\n')
    expect(statSync(file).mode & 0o777).toBe(0o755)
  })
})
