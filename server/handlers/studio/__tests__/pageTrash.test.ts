/**
 * pageTrash — unit tests for the recoverable half of removing a page.
 *
 * The two properties worth protecting: a trashed page is invisible to every
 * reader (because it lives under `.studio/`, which the workspace walk skips),
 * and a restore puts back EXACTLY what was moved — including a nested path,
 * which a flat copy could not recover.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { discoverPageFiles } from '../../studioProjects'
import { autoPlaceBoardFrame } from '../boardFrames'
import { listTrashedPages, purgeTrash, restoreTrashedPage, trashStudioPage } from '../pageTrash'

let tmpDir: string
let pagesDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-trash-'))
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

const PAGE_WITH_STYLES = "import styles from './Home.module.css'\nexport default function Home() { return <div className={styles.a} /> }\n"

describe('trashStudioPage', () => {
  it('moves the page out of the pages dir, so no reader can still find it', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')

    const result = trashStudioPage(tmpDir, 'home', 'Home')

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(pagesDir, 'Home.tsx'))).toBe(false)
    // The whole design rests on this: page discovery never looks in `.studio/`.
    expect(discoverPageFiles(pagesDir)).toEqual([])
  })

  it('takes the page stylesheet with it, so a restore brings back a whole page', () => {
    writePage('Home.tsx', PAGE_WITH_STYLES)
    fs.writeFileSync(path.join(pagesDir, 'Home.module.css'), '.a { color: red }\n')

    const result = trashStudioPage(tmpDir, 'home', 'Home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.files).toEqual(['pages/Home.tsx', 'pages/Home.module.css'])
    expect(fs.existsSync(path.join(pagesDir, 'Home.module.css'))).toBe(false)
  })

  it('leaves a stylesheet another page still imports', () => {
    writePage('Home.tsx', "import styles from './shared.css'\nexport default function Home() { return <div className={styles.a} /> }\n")
    writePage('About.tsx', "import styles from './shared.css'\nexport default function About() { return <div className={styles.a} /> }\n")
    fs.writeFileSync(path.join(pagesDir, 'shared.css'), '.a { color: red }\n')

    const result = trashStudioPage(tmpDir, 'home', 'Home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.files).toEqual(['pages/Home.tsx'])
    expect(fs.existsSync(path.join(pagesDir, 'shared.css'))).toBe(true)
  })

  it('removes the page board frames', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')
    autoPlaceBoardFrame(tmpDir, 'home')

    const result = trashStudioPage(tmpDir, 'home', 'Home')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.removedFrames).toBe(1)
  })

  it('reports an unknown id rather than throwing', () => {
    const result = trashStudioPage(tmpDir, 'nope', 'Nope')
    expect(result).toEqual({ ok: false, notFound: 'No page with id "nope" exists in this project.' })
  })
})

describe('listTrashedPages', () => {
  it('is empty for a project that has never trashed anything', () => {
    expect(listTrashedPages(tmpDir)).toEqual([])
  })

  it('survives a corrupt manifest instead of throwing', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio', 'trash'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'trash', 'manifest.json'), '{ not json')
    expect(listTrashedPages(tmpDir)).toEqual([])
  })

  it('lists newest first', async () => {
    writePage('One.tsx', 'export default function One() { return <div /> }\n')
    writePage('Two.tsx', 'export default function Two() { return <div /> }\n')
    trashStudioPage(tmpDir, 'one', 'One')
    await Bun.sleep(2) // distinct ISO timestamps
    trashStudioPage(tmpDir, 'two', 'Two')

    expect(listTrashedPages(tmpDir).map((entry) => entry.title)).toEqual(['Two', 'One'])
  })
})

describe('restoreTrashedPage', () => {
  it('puts every file back at its original path and re-places a board frame', () => {
    writePage('Home.tsx', PAGE_WITH_STYLES)
    fs.writeFileSync(path.join(pagesDir, 'Home.module.css'), '.a { color: red }\n')
    const trashed = trashStudioPage(tmpDir, 'home', 'Home')
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) return

    const result = restoreTrashedPage(tmpDir, trashed.entry.id)

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(pagesDir, 'Home.tsx'), 'utf8')).toBe(PAGE_WITH_STYLES)
    expect(fs.existsSync(path.join(pagesDir, 'Home.module.css'))).toBe(true)
    expect(listTrashedPages(tmpDir)).toEqual([])

    const boards = JSON.parse(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8')) as {
      boards: { frames: { pageId: string }[] }[]
    }
    expect(boards.boards.flatMap((board) => board.frames).map((frame) => frame.pageId)).toEqual(['home'])
  })

  it('restores a NESTED page to its original directory, not a flattened one', () => {
    writePage('marketing/Landing.tsx', 'export default function Landing() { return <div /> }\n')
    const trashed = trashStudioPage(tmpDir, 'marketing-landing', 'Landing')
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) return
    // The nested dir was pruned when it emptied — restore has to recreate it.
    expect(fs.existsSync(path.join(pagesDir, 'marketing'))).toBe(false)

    restoreTrashedPage(tmpDir, trashed.entry.id)

    expect(fs.existsSync(path.join(pagesDir, 'marketing', 'Landing.tsx'))).toBe(true)
  })

  it('refuses, and moves nothing, when a path it owns is occupied again', () => {
    writePage('Home.tsx', 'export default function Home() { return <div>original</div> }\n')
    const trashed = trashStudioPage(tmpDir, 'home', 'Home')
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) return
    writePage('Home.tsx', 'export default function Home() { return <div>the new one</div> }\n')

    const result = restoreTrashedPage(tmpDir, trashed.entry.id)

    expect(result.ok).toBe(false)
    if (!result.ok && 'conflict' in result) expect(result.conflict).toContain('pages/Home.tsx')
    // The newer file is untouched, and the entry is still recoverable.
    expect(fs.readFileSync(path.join(pagesDir, 'Home.tsx'), 'utf8')).toContain('the new one')
    expect(listTrashedPages(tmpDir)).toHaveLength(1)
  })

  it('reports an unknown entry id', () => {
    expect(restoreTrashedPage(tmpDir, 'nope')).toEqual({ ok: false, notFound: 'Nothing in the trash with id "nope".' })
  })
})

describe('purgeTrash', () => {
  it('permanently removes one entry and its parked files', () => {
    writePage('Home.tsx', 'export default function Home() { return <div /> }\n')
    const trashed = trashStudioPage(tmpDir, 'home', 'Home')
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) return

    expect(purgeTrash(tmpDir, trashed.entry.id)).toBe(1)
    expect(listTrashedPages(tmpDir)).toEqual([])
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'trash', trashed.entry.id))).toBe(false)
  })

  it('empties the whole trash when no id is given', () => {
    writePage('One.tsx', 'export default function One() { return <div /> }\n')
    writePage('Two.tsx', 'export default function Two() { return <div /> }\n')
    trashStudioPage(tmpDir, 'one', 'One')
    trashStudioPage(tmpDir, 'two', 'Two')

    expect(purgeTrash(tmpDir)).toBe(2)
    expect(listTrashedPages(tmpDir)).toEqual([])
  })

  it('is a no-op on an empty trash', () => {
    expect(purgeTrash(tmpDir)).toBe(0)
  })
})
