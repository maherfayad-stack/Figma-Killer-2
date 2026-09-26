/**
 * The writeback replaces a file in ONE step (review follow-up: "Studio's own
 * writeback is not atomic").
 *
 * Every codemod's `saveSync` and every stylesheet edit used to truncate the
 * user's file and then write it. Between the two, the P1-D watcher, Vite's HMR
 * or the canvas could read an empty or half-written module, and a process that
 * died there left it that way — in the user's own repository, the only copy.
 * Now both halves go through `writeFileAtomic`: a sibling temp file, renamed
 * over the target.
 *
 * The observable proof is the directory entry: a rename puts a NEW file at the
 * name (a new inode), an in-place write keeps the old one. Asserting on the
 * inode is what makes this test fail on the truncate-then-write path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEdit, applyStudioEditBatch } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-writeback-atomic-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

/** Nothing a write left behind: no `.<name>.<id>.studio-tmp` sibling. */
function tempLeftovers(relDir: string): string[] {
  return fs.readdirSync(path.join(tmpDir, ...relDir.split('/'))).filter((name) => name.endsWith('.studio-tmp'))
}

describe('writeback writes are atomic', () => {
  it('replaces a page through a rename, not a truncate-then-write', () => {
    const file = write('pages/Home.tsx', 'export const Home = () => <div>hi</div>\n')
    const before = fs.statSync(file).ino

    const result = applyStudioEditBatch(tmpDir, [{ kind: 'text', nodeId: 'pages/Home.tsx:1:28', text: 'hello' }])

    expect(result.written).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('export const Home = () => <div>hello</div>\n')
    expect(fs.statSync(file).ino).not.toBe(before)
    expect(tempLeftovers('pages')).toEqual([])
  })

  it('keeps a CRLF page CRLF through the atomic write', () => {
    const file = write('pages/Home.tsx', 'export const Home = () => (\r\n  <div>hi</div>\r\n)\r\n')
    const before = fs.statSync(file).ino

    applyStudioEdit(tmpDir, { kind: 'text', nodeId: 'pages/Home.tsx:2:4', text: 'hello' })

    expect(fs.readFileSync(file, 'utf8')).toBe('export const Home = () => (\r\n  <div>hello</div>\r\n)\r\n')
    expect(fs.statSync(file).ino).not.toBe(before)
  })

  it('replaces a stylesheet through a rename, not a truncate-then-write', () => {
    const file = write('src/screens/Home.css', '.hero {\n  color: red;\n}\n')
    const before = fs.statSync(file).ino

    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      op: 'set',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    })

    expect(applied.applied).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('.hero {\n  color: blue;\n}\n')
    expect(fs.statSync(file).ino).not.toBe(before)
    expect(tempLeftovers('src/screens')).toEqual([])
  })
})
