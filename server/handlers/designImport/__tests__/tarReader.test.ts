import { describe, expect, it } from 'bun:test'
import { readTarEntries } from '../tarReader'

const BLOCK_SIZE = 512

/** Builds one 512-byte ustar header block for a regular file entry. Mirrors just enough of the real format for the reader under test: name (0..100), size octal (124..136), typeflag (156). */
function buildHeader(name: string, size: number, typeflag = '0'): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE)
  const encoder = new TextEncoder()
  block.set(encoder.encode(name).subarray(0, 100), 0)
  const sizeOctal = size.toString(8).padStart(11, '0') + '\0'
  block.set(encoder.encode(sizeOctal), 124)
  block.set(encoder.encode(typeflag), 156)
  return block
}

function pad(bytes: Uint8Array): Uint8Array {
  const paddedLen = Math.ceil(bytes.length / BLOCK_SIZE) * BLOCK_SIZE
  const out = new Uint8Array(paddedLen)
  out.set(bytes, 0)
  return out
}

/** Concatenates entries (each `{name, contents}`) into a full tar buffer, including the two-zero-block end-of-archive marker. */
function buildTar(entries: Array<{ name: string; contents: string; typeflag?: string }>): Uint8Array {
  const parts: Uint8Array[] = []
  const encoder = new TextEncoder()
  for (const entry of entries) {
    const contentBytes = encoder.encode(entry.contents)
    parts.push(buildHeader(entry.name, contentBytes.byteLength, entry.typeflag))
    parts.push(pad(contentBytes))
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2)) // end-of-archive: two zeroed blocks

  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

describe('readTarEntries', () => {
  it('reads a single regular-file entry', () => {
    const tar = buildTar([{ name: 'package/pages/Home.css', contents: ':root{--x:1px}' }])
    const entries = readTarEntries(tar)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('package/pages/Home.css')
    expect(new TextDecoder().decode(entries[0].contents)).toBe(':root{--x:1px}')
  })

  it('reads multiple entries in sequence', () => {
    const tar = buildTar([
      { name: 'package/a.css', contents: 'A' },
      { name: 'package/b.css', contents: 'BB' },
      { name: 'package/c.css', contents: 'CCC' },
    ])
    const entries = readTarEntries(tar)
    expect(entries.map((e) => e.name)).toEqual(['package/a.css', 'package/b.css', 'package/c.css'])
    expect(entries.map((e) => new TextDecoder().decode(e.contents))).toEqual(['A', 'BB', 'CCC'])
  })

  it('handles content that is not a multiple of the 512-byte block size', () => {
    const tar = buildTar([{ name: 'package/odd.css', contents: 'x'.repeat(513) }])
    const entries = readTarEntries(tar)
    expect(entries).toHaveLength(1)
    expect(entries[0].contents.byteLength).toBe(513)
  })

  it('resolves a GNU long-name entry (typeflag L) onto the NEXT header', () => {
    const longName = 'package/' + 'deep/'.repeat(30) + 'file.css'
    const parts: Uint8Array[] = []
    const encoder = new TextEncoder()
    const nameBytes = encoder.encode(longName + '\0')
    parts.push(buildHeader('', nameBytes.byteLength, 'L'))
    parts.push(pad(nameBytes))
    const contentBytes = encoder.encode(':root{--y:2px}')
    parts.push(buildHeader('ignored-short-name.css', contentBytes.byteLength, '0'))
    parts.push(pad(contentBytes))
    parts.push(new Uint8Array(BLOCK_SIZE * 2))

    const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
    const tar = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { tar.set(part, offset); offset += part.byteLength }

    const entries = readTarEntries(tar)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(longName)
  })

  it('skips a directory entry (typeflag 5)', () => {
    const tar = buildTar([
      { name: 'package/subdir/', contents: '', typeflag: '5' },
      { name: 'package/subdir/file.css', contents: ':root{--z:3px}' },
    ])
    const entries = readTarEntries(tar)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('package/subdir/file.css')
  })

  it('returns an empty list for an archive with only the end-of-archive marker', () => {
    expect(readTarEntries(new Uint8Array(BLOCK_SIZE * 2))).toEqual([])
  })
})
