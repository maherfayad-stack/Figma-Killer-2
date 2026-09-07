/**
 * Project preview thumbnails (W7-3) — the three things that are not obvious
 * from reading the code.
 *
 * 1. **The route's containment and its conditional GET.** `dir` comes off a
 *    query string, so a path that is not a project directly inside the
 *    workspace must not become a filesystem read; and a launcher with twenty
 *    tiles must revalidate rather than re-download, which is only true if the
 *    ETag actually matches on the way back in.
 * 2. **The summary field.** `hasThumbnail`/`thumbnailUpdatedAt` are what the
 *    card decides between an image and a folder glyph with, and what the
 *    listing route enqueues on.
 * 3. **The queue's two invariants** — one capture at a time (the browser pool
 *    is a single Chromium), and a project whose capture failed is not tried
 *    again by the lazy backfill. Neither is observable from a call site, and
 *    both are the reason the queue exists at all. The capture function is
 *    injected, so none of this needs a browser.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioProjectSummary } from '../../studioProjects'
import { projectThumbnailFile, readProjectThumbnailStat } from '../projectThumbnailFile'
import { serveProjectThumbnail } from '../projectThumbnailRoute'
import { createProjectThumbnailQueue } from '../projectThumbnailQueue'
import { thumbnailPageId, type CaptureProjectThumbnailResult } from '../projectThumbnail'

// `realpathSync` because macOS's `/var/folders/…` tmpdir is a symlink and
// `projectsRootDir()` resolves the env override — an unresolved path would
// make every containment check compare two different spellings of one dir.
const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-thumbnail-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR

beforeAll(() => {
  process.env.STUDIO_WORKSPACE_DIR = workspaceRoot
})

afterAll(() => {
  // Restored, not deleted: `bun test` runs several files per process, so
  // leaving it set would relocate the workspace for whatever runs next.
  if (priorWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = priorWorkspaceDir
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const entry of fs.readdirSync(workspaceRoot)) {
    fs.rmSync(path.join(workspaceRoot, entry), { recursive: true, force: true })
  }
})

/** A 1×1 PNG — the smallest thing that is genuinely a PNG on disk. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function makeProject(folder: string): string {
  const dir = path.join(workspaceRoot, folder)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <div /> }\n')
  return dir
}

function writeThumbnail(dir: string): void {
  const file = projectThumbnailFile(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PNG_BYTES)
}

function get(dir: string | null, headers: Record<string, string> = {}): Response {
  const url = dir === null
    ? 'http://localhost/admin/api/studio/thumbnail'
    : `http://localhost/admin/api/studio/thumbnail?dir=${encodeURIComponent(dir)}`
  return serveProjectThumbnail(new Request(url, { headers }), new URL(url).searchParams.get('dir'))
}

describe('GET /admin/api/studio/thumbnail', () => {
  it('404s a project that has no thumbnail yet, uncached', () => {
    const res = get(makeProject('alpha'))

    expect(res.status).toBe(404)
    // The capture is very likely running right now — a browser that cached
    // this miss would keep the folder glyph up after the image lands.
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('serves the PNG with mtime-derived validators', async () => {
    const dir = makeProject('alpha')
    writeThumbnail(dir)

    const res = get(dir)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES))
    expect(res.headers.get('etag')).toBeTruthy()
    expect(res.headers.get('last-modified')).toBeTruthy()
    // Revalidate every time: a stale thumbnail is a picture of a screen the
    // user has already changed.
    expect(res.headers.get('cache-control')).toContain('must-revalidate')
  })

  it('304s a matching If-None-Match, with no body', async () => {
    const dir = makeProject('alpha')
    writeThumbnail(dir)
    const etag = get(dir).headers.get('etag') ?? ''

    const res = get(dir, { 'if-none-match': etag })

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(etag)
    expect(await res.text()).toBe('')
  })

  it('200s again once the file changes under the same ETag', async () => {
    const dir = makeProject('alpha')
    writeThumbnail(dir)
    const etag = get(dir).headers.get('etag') ?? ''

    // A different size is enough to move the ETag; mtime alone can land in the
    // same millisecond on a fast filesystem.
    fs.writeFileSync(projectThumbnailFile(dir), Buffer.concat([PNG_BYTES, PNG_BYTES]))

    expect(get(dir, { 'if-none-match': etag }).status).toBe(200)
  })

  it('refuses a dir that is not a project inside the workspace', () => {
    makeProject('alpha')

    // Traversal, a nested path inside a real project, and the workspace root
    // itself — the three shapes the parent-comparison check exists to reject.
    expect(get(path.join(workspaceRoot, 'alpha', '..', '..')).status).toBe(400)
    expect(get(path.join(workspaceRoot, 'alpha', 'pages')).status).toBe(400)
    expect(get(workspaceRoot).status).toBe(400)
    expect(get(path.join(workspaceRoot, '.trash')).status).toBe(400)
    expect(get('/etc').status).toBe(400)
  })

  it('404s a project directory that is gone, and 400s a missing dir', () => {
    expect(get(path.join(workspaceRoot, 'never-existed')).status).toBe(404)
    expect(get(null).status).toBe(400)
  })

  it('never reads a thumbnail through an uncontained path', () => {
    // The refusal must happen BEFORE any path is joined: a fixed filename read
    // off an arbitrary directory is still an arbitrary-path read.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-thumbnail-outside-'))
    try {
      fs.mkdirSync(path.join(outside, '.studio'), { recursive: true })
      fs.writeFileSync(path.join(outside, '.studio', 'thumbnail.png'), PNG_BYTES)

      const res = get(outside)

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).not.toBe('image/png')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('studioProjectSummary thumbnail fields', () => {
  it('reports no thumbnail and no timestamp when there is none', () => {
    const summary = studioProjectSummary(makeProject('alpha'))

    expect(summary.hasThumbnail).toBe(false)
    expect(summary.thumbnailUpdatedAt).toBeUndefined()
  })

  it('reports the file and its mtime once one exists', () => {
    const dir = makeProject('alpha')
    writeThumbnail(dir)

    const summary = studioProjectSummary(dir)

    expect(summary.hasThumbnail).toBe(true)
    expect(summary.thumbnailUpdatedAt).toBe(readProjectThumbnailStat(dir)?.mtimeMs)
  })
})

describe('thumbnailPageId', () => {
  function writeBoards(dir: string, frames: Array<{ pageId: string; x: number; y: number }>): void {
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.studio', 'boards.json'),
      JSON.stringify({
        boards: [
          { id: 'b1', name: 'Board', frames: frames.map((f, i) => ({ id: `f${i}`, ...f })) },
        ],
      }),
    )
  }

  it('is null for a project with no board frames', () => {
    expect(thumbnailPageId(makeProject('alpha'))).toBeNull()
  })

  it('picks the visually-first frame, not the first in the array', () => {
    const dir = makeProject('alpha')
    writeBoards(dir, [
      { pageId: 'pages/Settings.tsx:1:1', x: 900, y: 400 },
      { pageId: 'pages/Pricing.tsx:1:1', x: 100, y: 0 },
    ])

    expect(thumbnailPageId(dir)).toBe('pages/Pricing.tsx:1:1')
  })

  it('prefers a Home page wherever it sits on the board', () => {
    const dir = makeProject('alpha')
    writeBoards(dir, [
      { pageId: 'pages/Pricing.tsx:1:1', x: 0, y: 0 },
      { pageId: 'pages/marketing/Home.tsx:1:1', x: 2000, y: 2000 },
    ])

    expect(thumbnailPageId(dir)).toBe('pages/marketing/Home.tsx:1:1')
  })
})

describe('projectThumbnailQueue', () => {
  const ok = (dir: string): CaptureProjectThumbnailResult => ({ ok: true, file: `${dir}/t.png`, updatedAt: 1 })
  const fail = (): CaptureProjectThumbnailResult =>
    ({ ok: false, reason: 'no-frame', error: 'no frames' })

  /** Silences the queue's own `console.error` for the failure cases below. */
  const realError = console.error
  afterEach(() => {
    console.error = realError
  })

  it('runs one capture at a time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const queue = createProjectThumbnailQueue({
      hasThumbnail: () => false,
      capture: async (dir) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return ok(dir)
      },
    })

    for (const dir of ['/ws/a', '/ws/b', '/ws/c', '/ws/d']) queue.backfill(dir)
    await queue.idle()

    // The browser pool is ONE warm Chromium; four concurrent captures is the
    // shape `browserPool.ts` explicitly warns turns a shared server into an OOM.
    expect(maxInFlight).toBe(1)
  })

  it('captures a project once even when the launcher lists it repeatedly', async () => {
    const captured: string[] = []
    const queue = createProjectThumbnailQueue({
      hasThumbnail: () => false,
      capture: async (dir) => {
        captured.push(dir)
        return ok(dir)
      },
    })

    queue.backfill('/ws/a')
    queue.backfill('/ws/a')
    await queue.idle()

    expect(captured).toEqual(['/ws/a'])
  })

  it('never retries a project whose capture failed', async () => {
    console.error = () => {}
    const captured: string[] = []
    const queue = createProjectThumbnailQueue({
      hasThumbnail: () => false,
      capture: async (dir) => {
        captured.push(dir)
        return fail()
      },
    })

    queue.backfill('/ws/a')
    await queue.idle()
    // A second launcher render — the shape that would otherwise launch a
    // browser per render, forever, for a tile that will never change.
    queue.backfill('/ws/a')
    await queue.idle()

    expect(captured).toEqual(['/ws/a'])
  })

  it('skips a project that already has a thumbnail', async () => {
    const captured: string[] = []
    const queue = createProjectThumbnailQueue({
      hasThumbnail: (dir) => dir === '/ws/a',
      capture: async (dir) => {
        captured.push(dir)
        return ok(dir)
      },
    })

    queue.backfill('/ws/a')
    queue.backfill('/ws/b')
    await queue.idle()

    expect(captured).toEqual(['/ws/b'])
  })

  it('collapses a burst of saves into one capture, and forgives an earlier failure', async () => {
    console.error = () => {}
    const captured: string[] = []
    let succeed = false
    const queue = createProjectThumbnailQueue({
      saveDebounceMs: 1,
      hasThumbnail: () => false,
      capture: async (dir) => {
        captured.push(dir)
        return succeed ? ok(dir) : fail()
      },
    })

    // The failure the backfill now refuses to retry.
    queue.backfill('/ws/a')
    await queue.idle()
    expect(captured).toEqual(['/ws/a'])

    succeed = true
    for (let i = 0; i < 5; i += 1) queue.refreshAfterSave('/ws/a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await queue.idle()

    // One more capture, not five: a save is a stream, not an event. And it
    // happened at all, which is the point — a save is evidence the project
    // changed, so it clears the memo the backfill respects.
    expect(captured).toEqual(['/ws/a', '/ws/a'])
  })
})
