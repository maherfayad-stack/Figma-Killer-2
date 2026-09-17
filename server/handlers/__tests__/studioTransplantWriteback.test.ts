/**
 * D2 G3 — the `transplant` edit kind end to end through the save batch: the
 * ONE structural kind whose destination is deliberately in a different file.
 *
 * Three things are asserted here that no other suite can:
 *
 *  1. **Both files are in `touchedFiles`.** Only the ORIGIN is named by
 *     `edit.nodeId`; a destination missing from that set would make the batch
 *     report `shifted: false` for a write that moved every id in the file the
 *     element landed in — and the board would then trust stale ids.
 *  2. **The origin's orphaned import is pruned, the destination's carried one
 *     is not.** The existing prune pass is keyed on `delete`; a transplant
 *     removes markup exactly as a delete does, and getting the two sides the
 *     wrong way round deletes the import the codemod just wrote.
 *  3. **The path guard still holds on the DESTINATION id.** The same-file
 *     filter every other kind applies is deliberately absent here, so the
 *     containment guard inside `studioEditLocation` is the only thing standing
 *     between a hand-crafted `parentNodeId` and an arbitrary file write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transplant-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

const HOME_REL = 'pages/Home.tsx'
const ABOUT_REL = 'pages/About.tsx'

const HOME = `import { Badge } from '../ui/Badge'

export default function Home() {
  return (
    <main className="home">
      <h1>Home</h1>
      <Badge tone="quiet">New</Badge>
    </main>
  )
}
`

const ABOUT = `export default function About() {
  return (
    <main className="about">
      <h1>About</h1>
    </main>
  )
}
`

function id(rel: string, source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${rel}:${line}:${col}`
}

describe('applyStudioEditBatch — the transplant kind (D2 G3)', () => {
  beforeEach(() => {
    write(HOME_REL, HOME)
    write(ABOUT_REL, ABOUT)
  })

  it('moves the element between files and reports BOTH as touched', () => {
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
      },
    ])

    expect(result.written).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.shifted).toBe(true)
    expect(result.sharedComponents).toBe(true)
    expect(result.touchedFiles.map((file) => path.relative(tmpDir, file).split(path.sep).join('/')).sort()).toEqual([
      ABOUT_REL,
      HOME_REL,
    ])

    expect(read(HOME_REL)).not.toContain('<Badge')
    expect(read(ABOUT_REL)).toContain('<Badge tone="quiet">New</Badge>')
  })

  it('prunes the import the move orphaned in the ORIGIN, and keeps the one it carried into the DESTINATION', () => {
    applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
      },
    ])

    expect(read(HOME_REL)).not.toContain("from '../ui/Badge'")
    expect(read(ABOUT_REL)).toContain("import { Badge } from '../ui/Badge'")
  })

  it('a COPY leaves the origin file byte-identical, imports included', () => {
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
        copy: true,
      },
    ])

    expect(result.written).toBe(1)
    expect(read(HOME_REL)).toBe(HOME)
    expect(read(ABOUT_REL)).toContain('<Badge tone="quiet">New</Badge>')
  })

  it('lands beside an anchor in the DESTINATION file', () => {
    applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
        anchorNodeId: id(ABOUT_REL, ABOUT, 'h1'),
        position: 'before',
      },
    ])

    const after = read(ABOUT_REL)
    expect(after.indexOf('<Badge')).toBeLessThan(after.indexOf('<h1>'))
  })

  it('refuses captured-scope and writes NEITHER file', () => {
    const homeText = `export default function Home({ user }: { user: { name: string } }) {
  return (
    <main>
      <p>{user.name}</p>
    </main>
  )
}
`
    write(HOME_REL, homeText)

    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, homeText, 'p'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
      },
    ])

    expect(result.written).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]!.kind).toBe('transplant')
    expect(result.refusals[0]!.reason).toBe('captured-scope')
    expect(result.refusals[0]!.message).toContain('`user`')
    expect(read(HOME_REL)).toBe(homeText)
    expect(read(ABOUT_REL)).toBe(ABOUT)
  })

  it('refuses rather than writing when the destination id escapes the workspace', () => {
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: '../../../etc/evil.tsx:1:2',
      },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('not-found')
    expect(read(HOME_REL)).toBe(HOME)
    expect(read(ABOUT_REL)).toBe(ABOUT)
  })

  it('refuses rather than writing when the destination id names a file that is not app source', () => {
    write('.env', 'SECRET=1\n')
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: '.env:1:1',
      },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('not-found')
    expect(read('.env')).toBe('SECRET=1\n')
  })

  it('refuses a destination in the SAME file — that is an ordinary reparent', () => {
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(HOME_REL, HOME, 'main'),
      },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('same-file')
    expect(read(HOME_REL)).toBe(HOME)
  })

  it('drops an anchor that belongs to a THIRD file rather than writing against it', () => {
    write('pages/Other.tsx', ABOUT)
    applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id(HOME_REL, HOME, 'Badge'),
        parentNodeId: id(ABOUT_REL, ABOUT, 'main'),
        anchorNodeId: id('pages/Other.tsx', ABOUT, 'h1'),
        position: 'before',
      },
    ])

    // Appended rather than written against the foreign anchor — an honest
    // position, the same reading `insert`/`reparent` give a dropped anchor.
    const after = read(ABOUT_REL)
    expect(after.indexOf('<h1>')).toBeLessThan(after.indexOf('<Badge'))
    expect(read('pages/Other.tsx')).toBe(ABOUT)
  })
})
