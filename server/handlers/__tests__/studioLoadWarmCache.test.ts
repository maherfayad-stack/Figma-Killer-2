/**
 * P6-B (PERF-7, PERF-8) — the load's persistent parse cache, its invalidation,
 * and the forgery it must refuse.
 *
 * A "restart" here is `restartServer()`: every in-process cache dropped (the
 * loaded-project LRU, which takes the memo, the in-memory parse tier and the
 * kept ts-morph `Project` with it, plus the digest memo) — exactly what a new
 * process starts with. What survives is `.studio/cache/parse/` on disk and the
 * signing key in the (temp) data root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@core/page-tree'
import { clearFileDigests, sha256Hex } from '../studio/loadDigest'
import { clearLoadedProjects, isProjectLoaded, MAX_LOADED_PROJECTS } from '../studio/loadedProjects'
import { flushParseCacheWrites } from '../studio/pageParseCache'
import { clearParseCacheSigningKeys, parseCacheSigningKey } from '../studio/parseCacheStore'
import { loadStudioPages, loadStudioPagesShared } from '../studioPageLoad'
import { resolveWorkspaceRelativePath } from '../studio/gitPaths'

let dataDir: string
let savedDataDir: string | undefined
const projects: string[] = []

function newProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-warm-load-'))
  projects.push(dir)
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text)
  return dir
}

function write(dir: string, rel: string, text: string): void {
  const abs = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
}

/** Rewrite a file with its stamp pushed past anything a same-millisecond write could collide with. */
function edit(dir: string, rel: string, text: string): void {
  const abs = path.join(dir, ...rel.split('/'))
  const later = new Date(fs.statSync(abs).mtime.getTime() + 5000)
  fs.writeFileSync(abs, text, 'utf8')
  fs.utimesSync(abs, later, later)
}

/**
 * A load, then the disk writes it queued. The server drains them 50 ms after
 * the load (or at exit); a test drains them at once so it can read the store.
 */
async function load(dir: string): ReturnType<typeof loadStudioPages> {
  const result = await loadStudioPages(dir)
  flushParseCacheWrites()
  return result
}

function restartServer(): void {
  clearLoadedProjects()
  clearFileDigests()
}

function texts(pages: readonly Page[], pageId: string): string[] {
  const page = pages.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error(`no page ${pageId}`)
  return Object.values(page.nodes)
    .map((node) => node.props?.text)
    .filter((text): text is string => typeof text === 'string')
}

function storeDir(dir: string): string {
  return path.join(dir, '.studio', 'cache', 'parse')
}

function entryFiles(dir: string): string[] {
  try {
    return fs.readdirSync(storeDir(dir)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map((name) => path.join(storeDir(dir), name))
  } catch (_err) {
    return []
  }
}

function page(heading: string): string {
  return `export default function Page() {\n  return <main><h1>${heading}</h1></main>\n}\n`
}

const HOME_WITH_HERO = "import { Hero } from '../components/Hero'\n\nexport default function Home() {\n  return <main><Hero /></main>\n}\n"
const hero = (text: string) => `export function Hero() {\n  return <h1>${text}</h1>\n}\n`

beforeEach(() => {
  savedDataDir = process.env.STUDIO_DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-warm-load-data-'))
  process.env.STUDIO_DATA_DIR = dataDir
  clearParseCacheSigningKeys()
  restartServer()
})

afterEach(() => {
  restartServer()
  clearParseCacheSigningKeys()
  if (savedDataDir === undefined) delete process.env.STUDIO_DATA_DIR
  else process.env.STUDIO_DATA_DIR = savedDataDir
  for (const dir of projects.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('PERF-7 — the parse survives a restart', () => {
  it('a restarted server answers from `.studio/cache/parse/` without re-parsing', async () => {
    const dir = newProject({ 'pages/Home.tsx': HOME_WITH_HERO, 'components/Hero.tsx': hero('Persisted') })
    const cold = await load(dir)
    const [entry] = entryFiles(dir)
    expect(entry, 'the cold load persisted nothing').toBeDefined()
    const written = fs.statSync(entry!).mtimeMs
    const bytes = fs.readFileSync(entry!, 'utf8')

    restartServer()
    const warm = await load(dir)
    expect(warm.pages).toEqual(cold.pages)
    // A re-parse rewrites the entry; a disk hit leaves it exactly as it was.
    expect(fs.statSync(entry!).mtimeMs).toBe(written)
    expect(fs.readFileSync(entry!, 'utf8')).toBe(bytes)
  })

  it('the disk write is off the load\'s path: nothing is written during the load, and the drain runs by itself', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Deferred') })
    await loadStudioPages(dir)
    expect(entryFiles(dir), 'the load wrote its entry inline — that was 170–350 ms of a cold load').toEqual([])
    const deadline = Date.now() + 2000
    while (entryFiles(dir).length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(entryFiles(dir)).toHaveLength(1)
  })

  it('the store sits behind its own `.gitignore`, and Studio\'s git staging refuses it', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Ignored') })
    await load(dir)
    expect(fs.readFileSync(path.join(storeDir(dir), '.gitignore'), 'utf8')).toContain('*')
    const [entry] = entryFiles(dir)
    const rel = path.relative(dir, entry!).split(path.sep).join('/')
    expect(resolveWorkspaceRelativePath(dir, rel)).toBeNull()

    // A repository whose own .gitignore says nothing about `.studio/`: git
    // still ignores the cache, from the inside.
    let init: ReturnType<typeof Bun.spawnSync>
    try {
      init = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: dir })
    } catch (_err) {
      return // no git on this machine — the staging refusal above still holds
    }
    expect(init.exitCode).toBe(0)
    const ignored = Bun.spawnSync(['git', 'check-ignore', '--quiet', rel], { cwd: dir })
    expect(ignored.exitCode, 'git would stage the parse cache').toBe(0)
  })
})

describe('P6-B — a cached page is served only while every file it read is unchanged', () => {
  it('editing a DEPENDENCY (not the page) re-parses the page — in process', async () => {
    const dir = newProject({ 'pages/Home.tsx': HOME_WITH_HERO, 'components/Hero.tsx': hero('Before') })
    expect(texts((await load(dir)).pages, 'home')).toContain('Before')
    edit(dir, 'components/Hero.tsx', hero('AfterDependencyEdit'))
    const after = texts((await load(dir)).pages, 'home')
    expect(after).toContain('AfterDependencyEdit')
    expect(after).not.toContain('Before')
  })

  it('editing a DEPENDENCY while the server is down re-parses the page after the restart', async () => {
    const dir = newProject({ 'pages/Home.tsx': HOME_WITH_HERO, 'components/Hero.tsx': hero('Before') })
    await load(dir)
    restartServer()
    edit(dir, 'components/Hero.tsx', hero('EditedWhileDown'))
    const after = texts((await load(dir)).pages, 'home')
    expect(after).toContain('EditedWhileDown')
    expect(after).not.toContain('Before')
  })

  it('an import that resolved to NOTHING is a dependency: creating the file re-parses the page', async () => {
    const dir = newProject({ 'pages/Home.tsx': HOME_WITH_HERO })
    expect(texts((await load(dir)).pages, 'home')).not.toContain('NowItExists')
    write(dir, 'components/Hero.tsx', hero('NowItExists'))
    expect(texts((await load(dir)).pages, 'home')).toContain('NowItExists')
  })

  it('a page added a moment ago is never missing from the next load', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Home') })
    expect((await load(dir)).pages.map((p) => p.id)).toEqual(['home'])
    write(dir, 'pages/About.tsx', page('About'))
    expect((await load(dir)).pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
  })
})

describe('P6-B — the store is untrusted input', () => {
  function genuineEntry(dir: string): { file: string; signature: string; payload: string } {
    const [file] = entryFiles(dir)
    const text = fs.readFileSync(file!, 'utf8')
    return { file: file!, signature: text.slice(0, 64), payload: text.slice(65) }
  }

  async function forgedLoadShows(dir: string, forge: (entry: { file: string; signature: string; payload: string }) => string): Promise<string[]> {
    await load(dir)
    const entry = genuineEntry(dir)
    fs.writeFileSync(entry.file, forge(entry), 'utf8')
    restartServer()
    return texts((await load(dir)).pages, 'home')
  }

  it('a tampered result (genuine signature, edited payload) is rejected — the page shows the source', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('RealHeading') })
    const shown = await forgedLoadShows(dir, ({ signature, payload }) => `${signature}\n${payload.replace('RealHeading', 'FORGED')}`)
    expect(shown).toContain('RealHeading')
    expect(shown).not.toContain('FORGED')
  })

  it('an entry signed with any other key is rejected', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('RealHeading') })
    const shown = await forgedLoadShows(dir, ({ payload }) => {
      const forged = payload.replace('RealHeading', 'FORGED')
      return `${createHmac('sha256', randomBytes(32)).update(forged).digest('hex')}\n${forged}`
    })
    expect(shown).not.toContain('FORGED')
  })

  it('a correctly signed entry of the wrong SHAPE is rejected by the schema, not trusted', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('RealHeading') })
    const key = parseCacheSigningKey(dir)!
    const shown = await forgedLoadShows(dir, ({ payload }) => {
      const malformed = payload.replace('"deps":[', '"deps":"not-an-array","unused":[')
      return `${createHmac('sha256', key).update(malformed).digest('hex')}\n${malformed}`
    })
    expect(shown).toContain('RealHeading')
  })

  it('a genuine entry copied into ANOTHER project is rejected', async () => {
    const source = newProject({ 'pages/Home.tsx': page('FromOtherProject') })
    await load(source)
    const target = newProject({ 'pages/Home.tsx': page('TargetHeading') })
    await load(target)
    const [sourceEntry] = entryFiles(source)
    const [targetEntry] = entryFiles(target)
    fs.copyFileSync(sourceEntry!, targetEntry!)
    restartServer()
    const shown = texts((await load(target)).pages, 'home')
    expect(shown).toContain('TargetHeading')
    expect(shown).not.toContain('FromOtherProject')
  })

  it('garbage in the store is ignored and overwritten', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('RealHeading') })
    const shown = await forgedLoadShows(dir, () => 'not an entry at all')
    expect(shown).toContain('RealHeading')
    expect(genuineEntry(dir).payload).toContain('RealHeading')
  })

  it('never writes the signing key into the project it signs for (the Stop hook\'s data root)', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Hook') })
    process.env.STUDIO_DATA_DIR = path.join(dir, '.data')
    clearParseCacheSigningKeys()
    expect(parseCacheSigningKey(dir)).toBeNull()
    await load(dir)
    expect(fs.existsSync(path.join(dir, '.data'))).toBe(false)
    expect(entryFiles(dir)).toEqual([])
  })

  it('never creates the store through a symlinked `.studio/cache`', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Linked'), '.studio/meta.json': '{}' })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-warm-load-outside-'))
    projects.push(outside)
    try {
      fs.symlinkSync(outside, path.join(dir, '.studio', 'cache'), 'junction')
    } catch (_err) {
      return // this machine cannot create a directory link — nothing to test
    }
    await load(dir)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe('P6-B — one LRU of projects', () => {
  it('evicts the least recently loaded project, which comes back from disk', async () => {
    const dirs = Array.from({ length: MAX_LOADED_PROJECTS + 1 }, (_, i) => newProject({ 'pages/Home.tsx': page(`Project${i}`) }))
    // Back to back, no explicit drain: whatever the drain timer has not written yet, eviction writes.
    for (const dir of dirs) await loadStudioPages(dir)
    expect(isProjectLoaded(dirs[0]!)).toBe(false)
    expect(isProjectLoaded(dirs[dirs.length - 1]!)).toBe(true)

    const [entry] = entryFiles(dirs[0]!)
    const written = fs.statSync(entry!).mtimeMs
    expect(texts((await load(dirs[0]!)).pages, 'home')).toContain('Project0')
    expect(fs.statSync(entry!).mtimeMs, 'the evicted project was re-parsed instead of read back').toBe(written)
  })
})

describe('P6-B — the memo is shared with the route, private to everyone else', () => {
  it('a repeat load with nothing changed is the SAME result object for the route, a copy for tools', async () => {
    const dir = newProject({ 'pages/Home.tsx': page('Shared') })
    const first = await loadStudioPagesShared(dir)
    expect(await loadStudioPagesShared(dir)).toBe(first)
    const copy = await load(dir)
    expect(copy).not.toBe(first)
    expect(copy.pages).toEqual(first.pages)
  })
})

describe('P6-B — digests', () => {
  it('names a file by its bytes', () => {
    expect(sha256Hex('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
  })
})
