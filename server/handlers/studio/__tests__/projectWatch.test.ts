/**
 * P1-D (ERR-19) — the project watcher: a file changed on disk is reported,
 * once per burst, with WHO changed it — `studio` when the write happened inside
 * a project write-lock hold, `outside` otherwise — and nothing Studio keeps for
 * itself (`.studio/`, `node_modules`, `.git`, editor scratch files) is reported,
 * except the free canvas's `.studio/canvas/`.
 *
 * Real files, real `fs.watch`, both strategies: the recursive handle Windows
 * and macOS get, and the per-directory walk Linux gets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isProjectWatched,
  isWatchedProjectPath,
  subscribeProjectChanges,
  type ProjectChangeBatch,
  type ProjectWatchStrategy,
} from '../projectWatch'
import { withProjectWriteLock } from '../projectWriteLock'

let dir: string
const unsubscribes: (() => void)[] = []

const write = (rel: string, contents: string) => {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-watch-'))
  write('pages/Home.tsx', 'export default function Home() { return <p>Home</p> }\n')
  write('node_modules/pkg/index.js', 'module.exports = 1\n')
  write('.studio/boards.json', '{}\n')
  write('.studio/canvas/.keep', '')
})

afterEach(async () => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  // Windows holds the directory handle a moment after close.
  await sleep(50)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Subscribe, let the watch arm, and collect every batch. */
async function watchProject(strategy: ProjectWatchStrategy): Promise<ProjectChangeBatch[]> {
  const batches: ProjectChangeBatch[] = []
  unsubscribes.push(subscribeProjectChanges(dir, (batch) => batches.push(batch), { strategy }))
  await sleep(150)
  return batches
}

async function settle(batches: ProjectChangeBatch[], minBatches = 1): Promise<void> {
  const deadline = Date.now() + 5_000
  while (batches.length < minBatches && Date.now() < deadline) await sleep(25)
  // One quiet window more, so a straggling duplicate would have been delivered.
  await sleep(400)
}

const reported = (batches: ProjectChangeBatch[]) =>
  batches.flatMap((batch) => batch.changes.map((change) => `${change.origin} ${change.rel}`))

for (const strategy of ['recursive', 'per-directory'] as const) {
  describe(`projectWatch (${strategy})`, () => {
    it('reports an outside write once, however many events the OS sent for it (or failed to)', async () => {
      const batches = await watchProject(strategy)
      write('pages/Home.tsx', 'export default function Home() { return <p>Changed</p> }\n')
      write('pages/Home.tsx', 'export default function Home() { return <p>Changed again</p> }\n')
      await settle(batches)
      expect(batches).toHaveLength(1)
      expect(reported(batches)).toEqual(['outside pages/Home.tsx'])
      expect(batches[0]!.overflow).toBe(false)
    })

    it('reports every file of a burst across directories, even when the OS names none of them', async () => {
      // Measured under Bun 1.3 on Windows: this burst delivers two events,
      // `pages` and `src`, and neither names a file — `components` is not
      // mentioned at all. The snapshot comparison is what finds all four.
      write('pages/B.tsx', 'b')
      write('components/C.tsx', 'c')
      write('src/deep/D.tsx', 'd')
      const batches = await watchProject(strategy)
      for (const rel of ['pages/Home.tsx', 'pages/B.tsx', 'components/C.tsx', 'src/deep/D.tsx']) write(rel, `changed ${rel}`)
      await settle(batches)
      expect(reported(batches)).toEqual([
        'outside components/C.tsx',
        'outside pages/B.tsx',
        'outside pages/Home.tsx',
        'outside src/deep/D.tsx',
      ])
    })

    it("reports a write made inside a project write-lock hold as Studio's own", async () => {
      const batches = await watchProject(strategy)
      await withProjectWriteLock(dir, () => write('pages/Home.tsx', 'export default function Home() { return <p>Studio</p> }\n'))
      await settle(batches)
      expect(reported(batches)).toEqual(['studio pages/Home.tsx'])
    })

    it('never reports .studio/, node_modules or editor scratch files — but does report .studio/canvas/', async () => {
      const batches = await watchProject(strategy)
      write('.studio/boards.json', '{"boards":[]}\n')
      write('node_modules/pkg/index.js', 'module.exports = 2\n')
      write('pages/.Home.tsx.swp', 'x')
      write('pages/Home.tsx~', 'x')
      write('.studio/canvas/layer-1.tsx', 'export default function Layer() { return null }\n')
      await settle(batches)
      expect(reported(batches)).toEqual(['outside .studio/canvas/layer-1.tsx'])
    })

    it('reports a file created in a directory that did not exist when the watch started', async () => {
      const batches = await watchProject(strategy)
      write('components/cards/Card.tsx', 'export function Card() { return <div /> }\n')
      await settle(batches)
      expect(reported(batches)).toContain('outside components/cards/Card.tsx')
    })

    it('reports a deleted file as gone', async () => {
      const batches = await watchProject(strategy)
      fs.rmSync(path.join(dir, 'pages', 'Home.tsx'))
      await settle(batches)
      expect(batches.flatMap((batch) => batch.changes)).toContainEqual({
        rel: 'pages/Home.tsx',
        exists: false,
        origin: 'outside',
      })
    })
  })
}

describe('projectWatch lifetime', () => {
  it('shares one watcher between subscribers and closes it with the last', async () => {
    const first = subscribeProjectChanges(dir, () => {})
    const second = subscribeProjectChanges(dir, () => {})
    expect(isProjectWatched(dir)).toBe(true)
    first()
    expect(isProjectWatched(dir)).toBe(true)
    second()
    expect(isProjectWatched(dir)).toBe(false)
  })
})

describe('isWatchedProjectPath', () => {
  it('keeps app files and the free canvas, drops what Studio and tools keep for themselves', () => {
    expect(isWatchedProjectPath('pages/Home.tsx')).toBe(true)
    expect(isWatchedProjectPath('.studio/canvas/layer.tsx')).toBe(true)
    expect(isWatchedProjectPath('.studio/meta.json')).toBe(false)
    expect(isWatchedProjectPath('src/.studio/x.tsx')).toBe(false)
    expect(isWatchedProjectPath('node_modules/react/index.js')).toBe(false)
    expect(isWatchedProjectPath('packages/ui/node_modules/x.js')).toBe(false)
    expect(isWatchedProjectPath('.git/index')).toBe(false)
    expect(isWatchedProjectPath('dist/app.js')).toBe(false)
    expect(isWatchedProjectPath('pages/Home.tsx___jb_tmp___')).toBe(false)
    expect(isWatchedProjectPath('pages/4913')).toBe(false)
    expect(isWatchedProjectPath('')).toBe(false)
  })
})
