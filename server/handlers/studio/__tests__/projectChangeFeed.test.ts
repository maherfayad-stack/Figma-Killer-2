/**
 * P6-B (PERF-8) — the load path's view of the project watcher. The `/load`
 * memo and the kept ts-morph `Project` trust "the feed reported nothing" only
 * because `settle()` makes the watcher look NOW whenever its snapshot may be
 * behind: a pending event, a Studio write since the last walk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProjectChangeFeed } from '../projectChangeFeed'
import { settleProjectChanges, subscribeProjectChanges, type ProjectChangeBatch } from '../projectWatch'
import { withProjectWriteLock } from '../projectWriteLock'

let dir: string
let feed: ProjectChangeFeed | null = null

const write = (rel: string, contents: string) => {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-change-feed-'))
  write('pages/Home.tsx', 'export default function Home() { return <p>Home</p> }\n')
})

afterEach(async () => {
  feed?.close()
  feed = null
  await sleep(50)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ProjectChangeFeed', () => {
  it('reports nothing for a quiet project, and an empty set at the current cursor', async () => {
    feed = new ProjectChangeFeed(dir)
    await feed.settle()
    const cursor = feed.cursor()
    expect([...feed.changesSince(cursor)!]).toEqual([])
  })

  it('a Studio write is reported by the very next settle — no debounce wait', async () => {
    feed = new ProjectChangeFeed(dir)
    await feed.settle()
    const cursor = feed.cursor()
    await withProjectWriteLock(dir, () => write('pages/About.tsx', 'export default function About() { return <p/> }\n'))
    // No sleep: the load that follows a save must not be answered from before it.
    await feed.settle()
    expect([...feed.changesSince(cursor)!]).toContain('pages/About.tsx')
  })

  it('an outside write is reported once its event arrives, by the settle that follows it', async () => {
    feed = new ProjectChangeFeed(dir)
    await feed.settle()
    const cursor = feed.cursor()
    write('pages/Home.tsx', 'export default function Home() { return <p>Edited</p> }\n')
    await sleep(60) // the OS event, not the watcher's 150 ms debounce
    await feed.settle()
    expect([...feed.changesSince(cursor)!]).toContain('pages/Home.tsx')
  })

  it('accumulates every batch since a cursor, not only the last', async () => {
    feed = new ProjectChangeFeed(dir)
    await feed.settle()
    const cursor = feed.cursor()
    await withProjectWriteLock(dir, () => write('a.ts', 'export const a = 1\n'))
    await feed.settle()
    await withProjectWriteLock(dir, () => write('b.ts', 'export const b = 1\n'))
    await feed.settle()
    expect([...feed.changesSince(cursor)!].sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('settleProjectChanges re-walks synchronously after a Studio write, before any watch event has arrived', async () => {
    const batches: ProjectChangeBatch[] = []
    const unsubscribe = subscribeProjectChanges(dir, (batch) => batches.push(batch))
    try {
      await sleep(150)
      batches.length = 0
      await withProjectWriteLock(dir, () => write('pages/Saved.tsx', 'export default function Saved() { return <p/> }\n'))
      // Only microtasks have run since the write: no fs event can have been
      // delivered, so only the write session can tell the watcher to look.
      expect(settleProjectChanges(dir, { maxSnapshotAgeMs: 10_000 })).toBe(true)
      expect(batches.flatMap((batch) => batch.changes.map((change) => change.rel))).toContain('pages/Saved.tsx')
    } finally {
      unsubscribe()
    }
  })

  it('settleProjectChanges says so when a directory has no watcher at all', () => {
    expect(settleProjectChanges(dir, { maxSnapshotAgeMs: 10_000 })).toBe(false)
  })
})
