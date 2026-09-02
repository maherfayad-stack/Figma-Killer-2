/**
 * pageDelete — unit tests for deleting a page from the project for real.
 *
 * The behaviour under test is the whole reason the module exists: before it,
 * `deletePage` spliced the page out of the in-memory tree and the `.tsx`
 * stayed on disk, so the next reload parsed it straight back in. Each test
 * below asserts one half of "the file is gone AND nothing it did not own went
 * with it".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deleteStudioPage } from '../pageDelete'
import { autoPlaceBoardFrame } from '../boardFrames'

let tmpDir: string
let pagesDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-delete-'))
  pagesDir = path.join(tmpDir, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writePage(relPath: string, body: string): void {
  const file = path.join(pagesDir, relPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function readBoardsFile(): { boards: { frames: { pageId: string }[] }[] } {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8'))
}

describe('deleteStudioPage', () => {
  it('deletes the page file the id resolves to', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')
    writePage('About.tsx', 'export default function About() { return <div /> }\n')

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(pagesDir, 'Home.tsx'))).toBe(false)
    // The sibling is untouched — an id resolves to exactly one file.
    expect(fs.existsSync(path.join(pagesDir, 'About.tsx'))).toBe(true)
  })

  it('reports the id as not found rather than throwing, and writes nothing', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')

    const result = deleteStudioPage(tmpDir, 'nope')

    expect(result).toEqual({ ok: false, notFound: 'No page with id "nope" exists in this project.' })
    expect(fs.existsSync(path.join(pagesDir, 'Home.tsx'))).toBe(true)
  })

  it('deletes a stylesheet the page imported once nothing else references it', () => {
    writePage('Home.tsx', "import styles from './Home.module.css'\nexport default function Home() { return <div className={styles.a} /> }\n")
    fs.writeFileSync(path.join(pagesDir, 'Home.module.css'), '.a { color: red }\n')

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(pagesDir, 'Home.module.css'))).toBe(false)
    if (result.ok) expect(result.removedFiles).toEqual(['pages/Home.tsx', 'pages/Home.module.css'])
  })

  it('keeps a stylesheet another page still imports', () => {
    writePage('Home.tsx', "import styles from './shared.css'\nexport default function Home() { return <div className={styles.a} /> }\n")
    writePage('About.tsx', "import styles from './shared.css'\nexport default function About() { return <div className={styles.a} /> }\n")
    fs.writeFileSync(path.join(pagesDir, 'shared.css'), '.a { color: red }\n')

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(pagesDir, 'shared.css'))).toBe(true)
    if (result.ok) expect(result.removedFiles).toEqual(['pages/Home.tsx'])
  })

  it('never deletes a stylesheet that came from a package', () => {
    writePage('Home.tsx', "import '@alm-design/design-system/styles.css'\nexport default function Home() { return <div /> }\n")

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.removedFiles).toEqual(['pages/Home.tsx'])
  })

  it('removes every board frame of the page, on every board', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')
    writePage('About.tsx', 'export default function About() { return <div /> }\n')
    autoPlaceBoardFrame(tmpDir, 'home')
    autoPlaceBoardFrame(tmpDir, 'about')

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.removedFrames).toBe(1)
    const remaining = readBoardsFile().boards.flatMap((board) => board.frames.map((frame) => frame.pageId))
    expect(remaining).toEqual(['about'])
  })

  it('succeeds for a page that was never placed on a board', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')

    const result = deleteStudioPage(tmpDir, 'home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.removedFrames).toBe(0)
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'boards.json'))).toBe(false)
  })

  it('prunes the directory a nested page leaves empty, but never the pages root', () => {
    writePage('marketing/Landing.tsx', 'export default function Landing() { return <div /> }\n')

    const result = deleteStudioPage(tmpDir, 'marketing-landing')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(pagesDir, 'marketing'))).toBe(false)
    expect(fs.existsSync(pagesDir)).toBe(true)
  })

  it('leaves a directory that still holds another page', () => {
    writePage('marketing/Landing.tsx', 'export default function Landing() { return <div /> }\n')
    writePage('marketing/Pricing.tsx', 'export default function Pricing() { return <div /> }\n')

    deleteStudioPage(tmpDir, 'marketing-landing')

    expect(fs.existsSync(path.join(pagesDir, 'marketing', 'Pricing.tsx'))).toBe(true)
  })
})
