/**
 * pageScaffold — unit tests for the three pure(ish) pieces WS-13 step 4 adds
 * around `POST /admin/api/studio/page`, independent of the HTTP layer (see
 * `server/handlers/__tests__/studio.test.ts` for the end-to-end route tests).
 *
 * `starterPage`'s own canonicality — zero `checkCanonicalJsx` violations — is
 * asserted in `studio.test.ts`'s "the scaffolded page passes checkCanonicalJsx
 * with zero violations" test, against the real HTTP route, since that is the
 * thing WS-13's step 1 validator exists to close the loop on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { autoPlaceBoardFrame, detectPageFileExtension, scaffoldedPageRootNodeId } from '../pageScaffold'
import { starterPage } from '../../studioProjects'
import { writeStudioMeta } from '../studioMeta'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-scaffold-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('detectPageFileExtension', () => {
  it('defaults to .tsx when the pages dir does not exist yet', () => {
    expect(detectPageFileExtension(path.join(tmpDir, 'pages'))).toBe('.tsx')
  })

  it('defaults to .tsx when the pages dir is empty', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    expect(detectPageFileExtension(pagesDir)).toBe('.tsx')
  })

  it('matches an unambiguously all-.jsx project', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    fs.writeFileSync(path.join(pagesDir, 'Home.jsx'), 'export default function Home() { return <div /> }\n')
    fs.writeFileSync(path.join(pagesDir, 'About.jsx'), 'export default function About() { return <div /> }\n')
    expect(detectPageFileExtension(pagesDir)).toBe('.jsx')
  })

  it('defaults to .tsx for an all-.tsx project', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    fs.writeFileSync(path.join(pagesDir, 'Home.tsx'), 'export default function Home() { return <div /> }\n')
    expect(detectPageFileExtension(pagesDir)).toBe('.tsx')
  })

  it('defaults to .tsx for a mixed project — .tsx present at all wins', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    fs.writeFileSync(path.join(pagesDir, 'Legacy.jsx'), 'export default function Legacy() { return <div /> }\n')
    fs.writeFileSync(path.join(pagesDir, 'New.tsx'), 'export default function New() { return <div /> }\n')
    expect(detectPageFileExtension(pagesDir)).toBe('.tsx')
  })
})

describe('autoPlaceBoardFrame', () => {
  function readBoardsFile(): {
    boards: { id: string; name: string; frames: { id: string; pageId: string; x: number; y: number }[] }[]
  } {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8'))
  }

  it('creates .studio/boards.json with a fresh "Board 1" when none exists', () => {
    autoPlaceBoardFrame(tmpDir, 'home')
    const file = readBoardsFile()
    expect(file.boards).toHaveLength(1)
    expect(file.boards[0]!.name).toBe('Board 1')
    expect(file.boards[0]!.frames).toHaveLength(1)
    const [frame] = file.boards[0]!.frames
    // WS-10 Phase 2 — every frame carries its OWN `id` (distinct from
    // `pageId`), minted by the caller (this function), never the pure
    // `upsertFrame` model. Assert it exists without pinning the exact value.
    expect(typeof frame!.id).toBe('string')
    expect(frame!.id.length).toBeGreaterThan(0)
    expect(frame).toMatchObject({ pageId: 'home', x: 0, y: 0 })
  })

  it('places each subsequent page at the next free grid slot', () => {
    autoPlaceBoardFrame(tmpDir, 'first')
    autoPlaceBoardFrame(tmpDir, 'second')
    autoPlaceBoardFrame(tmpDir, 'third')
    const file = readBoardsFile()
    expect(file.boards[0]!.frames).toHaveLength(3)
    expect(file.boards[0]!.frames[0]).toMatchObject({ pageId: 'first', x: 0, y: 0 })
    expect(file.boards[0]!.frames[1]).toMatchObject({ pageId: 'second', x: 1104, y: 0 }) // FRAME_WIDTH(1024) + FRAME_GAP(80), column 2
    expect(file.boards[0]!.frames[2]).toMatchObject({ pageId: 'third', x: 0, y: 880 }) // row 2 (FRAME_HEIGHT 800 + FRAME_GAP 80)
    // Each frame's own id is distinct — never re-used across pages.
    const ids = new Set(file.boards[0]!.frames.map((f) => f.id))
    expect(ids.size).toBe(3)
  })

  it('targets the FIRST board when one already exists, preserving its id/name', () => {
    const boardsDir = path.join(tmpDir, '.studio')
    fs.mkdirSync(boardsDir, { recursive: true })
    fs.writeFileSync(
      path.join(boardsDir, 'boards.json'),
      JSON.stringify({ version: 1, boards: [{ id: 'existing-id', name: 'Main', frames: [], notes: [], docs: [] }] }),
    )
    autoPlaceBoardFrame(tmpDir, 'home')
    const file = readBoardsFile()
    expect(file.boards).toHaveLength(1)
    expect(file.boards[0]!.id).toBe('existing-id')
    expect(file.boards[0]!.name).toBe('Main')
    expect(file.boards[0]!.frames).toHaveLength(1)
    expect(file.boards[0]!.frames[0]).toMatchObject({ pageId: 'home', x: 0, y: 0 })
  })

  it('is idempotent — re-calling with a pageId already on the board does not duplicate or move it', () => {
    autoPlaceBoardFrame(tmpDir, 'home')
    autoPlaceBoardFrame(tmpDir, 'about') // a second, unrelated frame in between
    autoPlaceBoardFrame(tmpDir, 'home') // re-call
    const file = readBoardsFile()
    expect(file.boards[0]!.frames.filter((f) => f.pageId === 'home')).toHaveLength(1)
    expect(file.boards[0]!.frames.find((f) => f.pageId === 'home')).toMatchObject({ pageId: 'home', x: 0, y: 0 })
  })

  it('applies the project frame default size (WS-7.2), same precedent as boardSlice.ts addFrame', () => {
    writeStudioMeta(tmpDir, { frameDefaults: { width: 500, height: 400 } })
    autoPlaceBoardFrame(tmpDir, 'home')
    const file = readBoardsFile()
    expect(file.boards[0]!.frames[0]).toMatchObject({ pageId: 'home', x: 0, y: 0, width: 500, height: 400 })
  })
})

describe('scaffoldedPageRootNodeId', () => {
  it('returns the real root node id by parsing the file — never a constructed string', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    const file = path.join(pagesDir, 'Home.tsx')
    fs.writeFileSync(file, starterPage('Home'))
    const rootNodeId = scaffoldedPageRootNodeId(tmpDir, file)
    expect(rootNodeId).toBeDefined()
    expect(rootNodeId).toMatch(/^pages\/Home\.tsx:\d+:\d+$/)
  })

  it('returns undefined, never throws, for a file with no JSX to parse', () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    const file = path.join(pagesDir, 'Empty.tsx')
    fs.writeFileSync(file, 'export default function Empty() { return null }\n')
    expect(() => scaffoldedPageRootNodeId(tmpDir, file)).not.toThrow()
    expect(scaffoldedPageRootNodeId(tmpDir, file)).toBeUndefined()
  })
})
