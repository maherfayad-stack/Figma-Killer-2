/**
 * prototypeShellBoards — the multi-board half of the export.
 *
 * The bug this covers, verbatim from the user: "I created another board, and
 * don't see it in the exported one when download code — I should see the
 * boards as tabs in the downloaded one."
 *
 * Two independent failures produced that, and each has its own describe block:
 *
 *   1. `registry.generated.jsx` never got regenerated, because the generator
 *      only ran on project load and creating a board does not change any file
 *      the load memo fingerprints. The zip therefore shipped whatever the
 *      boards were the last time the parse ran — one board, under its old
 *      name. `buildStudioDownloadResponse` now regenerates first.
 *   2. The shell rendered the board tab row only in the flow view, and drew
 *      every board as a stacked row on the canvas. A second board existed in
 *      the emitted data and was still not presentable as a tab.
 *
 * The zip is opened for real (`unzipSync`) rather than asserted on a mock: the
 * claim under test is "the byte the user downloads contains the new board",
 * and only the actual archive can answer that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import type { BoardsFile } from '@core/studio-board'
import { ensurePrototypeShell } from '../prototypeShell'
import { renderRegistryFile } from '../prototypeShell/registryFile'
import { buildStudioDownloadResponse } from '../../studioDownload'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-boards-'))
  fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true })
  for (const name of ['Home', 'Details', 'Settings']) {
    fs.writeFileSync(
      path.join(tmpDir, 'pages', `${name}.tsx`),
      `export default function ${name}() { return <div /> }\n`,
    )
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Write `.studio/boards.json` directly — the file the canvas owns and the generator reads. */
function writeBoards(boards: BoardsFile['boards']): void {
  fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.studio', 'boards.json'),
    `${JSON.stringify({ version: 1, boards }, null, 2)}\n`,
  )
}

function frame(id: string, pageId: string, x: number, y: number): Record<string, unknown> {
  return { id, pageId, x, y, width: 393, height: 852 }
}

/** The two boards from the report: one populated, one created afterwards. */
const TWO_BOARDS = [
  {
    id: 'board-test',
    name: 'Test',
    frames: [frame('f1', 'home', 0, 0), frame('f2', 'details', 420, 0)],
  },
  {
    id: 'board-testtt',
    name: 'Testtt',
    frames: [frame('f3', 'settings', 0, 0)],
  },
]

function read(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')
}

describe('registry.generated.jsx — every board, in file order', () => {
  it('emits one BOARDS entry per board, in `.studio/boards.json` order', () => {
    writeBoards(TWO_BOARDS)
    ensurePrototypeShell(tmpDir)

    const registry = read('prototype/registry.generated.jsx')
    expect(registry).toContain('id: "board-test"')
    expect(registry).toContain('name: "Test"')
    expect(registry).toContain('id: "board-testtt"')
    expect(registry).toContain('name: "Testtt"')
    // Order is the file's, not alphabetical and not frame-count-ranked: the
    // tab row reads left to right in the order the author sees in Studio.
    expect(registry.indexOf('"board-test"')).toBeLessThan(registry.indexOf('"board-testtt"'))
  })

  it('keeps each board\'s frames on that board', () => {
    writeBoards(TWO_BOARDS)
    ensurePrototypeShell(tmpDir)

    const registry = read('prototype/registry.generated.jsx')
    const second = registry.slice(registry.indexOf('"board-testtt"'))
    expect(second).toContain('"pageId":"settings"')
    // The first board's pages must NOT have leaked into the second's entry.
    expect(second).not.toContain('"pageId":"home"')
    expect(second).not.toContain('"pageId":"details"')
  })

  it('keeps a board that has no frames yet — it is still a tab the author made', () => {
    writeBoards([...TWO_BOARDS, { id: 'board-empty', name: 'Empty', frames: [] }])
    ensurePrototypeShell(tmpDir)

    expect(read('prototype/registry.generated.jsx')).toContain('name: "Empty"')
  })

  it('drops a frame whose page has been deleted, without dropping its board', () => {
    writeBoards([
      { id: 'board-a', name: 'A', frames: [frame('f1', 'home', 0, 0), frame('f9', 'ghost', 40, 0)] },
    ])
    ensurePrototypeShell(tmpDir)

    const registry = read('prototype/registry.generated.jsx')
    expect(registry).toContain('name: "A"')
    // A frame with no page is a broken import, which an empty tab is not.
    expect(registry).not.toContain('"pageId":"ghost"')
    expect(registry).toContain('"pageId":"home"')
  })

  it('emits an empty BOARDS array for a project with no boards file, not a broken module', () => {
    const registry = renderRegistryFile({
      projectName: 'p',
      screens: [],
      boards: { version: 1, boards: [] },
      frameDefaults: { width: 393, height: 852 },
      previewAxes: { direction: 'ltr', colorScheme: 'light' },
      colorScheme: null,
      hasLanguageProvider: false,
      locales: ['en'],
      hasDesignSystem: false,
      links: [],
    })
    expect(registry).toContain('export const BOARDS = [')
    expect(registry).toContain('export const SCREENS = [')
  })
})

describe('App.jsx — boards are tabs, in both views', () => {
  it('renders the board tab row without gating it on the view', () => {
    ensurePrototypeShell(tmpDir)
    const app = read('prototype/App.jsx')

    expect(app).toContain('aria-label="Boards"')
    // The regression: `view !== 'canvas' && BOARDS.length > 1` hid the tab row
    // on the canvas, which is the view a downloaded prototype opens on.
    expect(app).not.toContain("view !== 'canvas' && BOARDS.length > 1")
    expect(app).toContain('{BOARDS.length > 1 && (')
  })

  it('draws only the active board on the canvas, not every board stacked', () => {
    ensurePrototypeShell(tmpDir)
    const app = read('prototype/App.jsx')

    expect(app).toContain('rows={board ? [{')
    expect(app).not.toContain('rows={BOARDS.map(')
  })

  it('scopes the screen row to the active board', () => {
    ensurePrototypeShell(tmpDir)
    const app = read('prototype/App.jsx')

    expect(app).toContain('const boardScreens =')
    expect(app).toContain('boardScreens.map((entry) =>')
  })
})

describe('the download zip carries the boards as they are NOW', () => {
  it('includes a board created after the last project load', async () => {
    // The project as it was when it was last opened: one board.
    writeBoards([TWO_BOARDS[0]!])
    ensurePrototypeShell(tmpDir)
    expect(read('prototype/registry.generated.jsx')).not.toContain('Testtt')

    // The user adds a second board on the canvas. Nothing re-parses — creating
    // a board touches no source file, so the load memo never invalidates.
    writeBoards(TWO_BOARDS)

    const res = buildStudioDownloadResponse(tmpDir)
    expect(res.status).toBe(200)
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
    const registry = strFromU8(entries['prototype/registry.generated.jsx']!)

    expect(registry).toContain('name: "Testtt"')
    expect(registry).toContain('"pageId":"settings"')
  })

  it('ships the shell itself, and never ships `.studio/`', async () => {
    writeBoards(TWO_BOARDS)

    const res = buildStudioDownloadResponse(tmpDir)
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))

    expect(names).toContain('prototype/App.jsx')
    expect(names).toContain('prototype/registry.generated.jsx')
    expect(names).toContain('index.html')
    // `.studio/` is excluded by design, which is exactly why the board layout
    // has to be baked into the generated registry to reach the export at all.
    expect(names.some((name) => name.startsWith('.studio/'))).toBe(false)
  })

  it('scaffolds the shell into a workspace that has never been opened', async () => {
    writeBoards(TWO_BOARDS)
    // No ensurePrototypeShell() first — the download is the first thing that
    // ever ran against this directory.
    const res = buildStudioDownloadResponse(tmpDir)
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))

    expect(strFromU8(entries['prototype/registry.generated.jsx']!)).toContain('name: "Testtt"')
  })

  it('404s a directory that does not exist, and writes nothing', () => {
    const missing = path.join(tmpDir, 'nope')
    const res = buildStudioDownloadResponse(missing)

    expect(res.status).toBe(404)
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('leaves a corrupt boards file as a shell with no boards rather than throwing', async () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'boards.json'), '{ not json')

    const res = buildStudioDownloadResponse(tmpDir)
    expect(res.status).toBe(200)
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
    // The shell is an addition, never a precondition: an unreadable
    // `.studio/` must not take the download down with it.
    expect(entries['index.html']).toBeDefined()
  })
})
