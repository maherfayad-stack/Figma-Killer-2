/**
 * `withWorkspaceProject` — the kept ts-morph `Project` behind every load.
 *
 * What a caller may rely on: the same `Project` comes back across calls, and
 * before each call it reflects every change the project watcher has reported
 * — an edited file is re-read, a new file is present, a deleted file is gone,
 * an in-memory file a previous caller created is gone — and two callers never
 * run at once. A change the watcher has not delivered yet is caught by
 * `resyncStale`, which the load runs over every file a parse read (P6-B).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Project } from 'ts-morph'
import { projectsRootDir } from '../studioProjects'
import { clearLoadedProjects } from '../studio/loadedProjects'
import { clearWorkspaceProjects, prewarmWorkspaceProgram, withWorkspaceProject } from '../studio/workspaceProject'

/** Long enough for the project watcher to deliver a write's event; its debounce is then flushed by the next call's settle. */
function watcherDelivery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100))
}

describe('withWorkspaceProject', () => {
  let wsDir: string

  function write(relPath: string, contents: string): void {
    const full = path.join(wsDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  function sourceText(project: Project, relPath: string): string | undefined {
    return project.getSourceFile(path.join(wsDir, ...relPath.split('/')))?.getFullText()
  }

  beforeEach(() => {
    clearWorkspaceProjects()
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__workspace_project_test_'))
    write('pages/Home.tsx', 'export default function Home() { return <div>one</div> }\n')
    write('prototype/main.jsx', 'export const shell = 1\n')
  })

  afterEach(() => {
    clearLoadedProjects()
    fs.rmSync(wsDir, { recursive: true, force: true })
    clearWorkspaceProjects()
  })

  it('hands back the SAME Project across calls, without the preview shell in it', async () => {
    const first = await withWorkspaceProject(wsDir, async ({ project }) => project)
    const second = await withWorkspaceProject(wsDir, async ({ project }) => project)
    expect(second).toBe(first)
    expect(sourceText(first, 'pages/Home.tsx')).toContain('one')
    expect(sourceText(first, 'prototype/main.jsx')).toBeUndefined()
  })

  it('re-reads a file whose contents changed on disk', async () => {
    await withWorkspaceProject(wsDir, async () => undefined)
    // A same-millisecond rewrite has the same mtime — push it forward so the
    // stamp moves the way a real edit's does.
    write('pages/Home.tsx', 'export default function Home() { return <div>two</div> }\n')
    const later = new Date(Date.now() + 2_000)
    fs.utimesSync(path.join(wsDir, 'pages', 'Home.tsx'), later, later)
    await watcherDelivery()

    const text = await withWorkspaceProject(wsDir, async ({ project }) => sourceText(project, 'pages/Home.tsx'))
    expect(text).toContain('two')
    expect(text).not.toContain('one')
  })

  it('resyncStale re-reads a file the watcher has not reported yet, and says so', async () => {
    await withWorkspaceProject(wsDir, async () => undefined)
    const home = path.join(wsDir, 'pages', 'Home.tsx')
    // Written INSIDE the callback, after this call's sync: only resyncStale can see it.
    const [stale, again, text] = await withWorkspaceProject(wsDir, async ({ project, resyncStale }) => {
      write('pages/Home.tsx', 'export default function Home() { return <div>three</div> }\n')
      const later = new Date(Date.now() + 4_000)
      fs.utimesSync(home, later, later)
      return [resyncStale([home]), resyncStale([home]), sourceText(project, 'pages/Home.tsx')] as const
    })
    expect(stale).toBe(true)
    expect(again).toBe(false)
    expect(text).toContain('three')
  })

  it('resyncStale adds a source file that appeared, and ignores files that are not source', async () => {
    await withWorkspaceProject(wsDir, async () => undefined)
    const [stale, text] = await withWorkspaceProject(wsDir, async ({ project, resyncStale }) => {
      write('components/Card.tsx', 'export function Card() { return <b>card</b> }\n')
      write('src/copy.json', '{"a":1}')
      return [
        resyncStale([path.join(wsDir, 'components', 'Card.tsx'), path.join(wsDir, 'src', 'copy.json')]),
        sourceText(project, 'components/Card.tsx'),
      ] as const
    })
    expect(stale).toBe(true)
    expect(text).toContain('card')
  })

  it('adds a new file and drops a deleted one', async () => {
    await withWorkspaceProject(wsDir, async () => undefined)
    write('pages/About.tsx', 'export default function About() { return <div>about</div> }\n')
    fs.rmSync(path.join(wsDir, 'pages', 'Home.tsx'))
    await watcherDelivery()

    const [about, home] = await withWorkspaceProject(wsDir, async ({ project }) => [
      sourceText(project, 'pages/About.tsx'),
      sourceText(project, 'pages/Home.tsx'),
    ])
    expect(about).toContain('about')
    expect(home).toBeUndefined()
  })

  it('drops an in-memory file a previous caller created on the shared Project', async () => {
    await withWorkspaceProject(wsDir, async ({ project }) => {
      project.createSourceFile(path.join(wsDir, 'scan.tsx'), 'export const x = 1\n')
    })
    const stillThere = await withWorkspaceProject(wsDir, async ({ project }) => sourceText(project, 'scan.tsx'))
    expect(stillThere).toBeUndefined()
  })

  it('runs callers one at a time', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = withWorkspaceProject(wsDir, async () => {
      order.push('first:start')
      await firstMayFinish
      order.push('first:end')
    })
    const second = withWorkspaceProject(wsDir, async () => {
      order.push('second')
    })
    // The first caller starts once its sync has settled the change feed; the
    // second must still be waiting well after that.
    while (order.length === 0) await new Promise((resolve) => setImmediate(resolve))
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('a caller that throws does not wedge the queue', async () => {
    await expect(withWorkspaceProject(wsDir, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const text = await withWorkspaceProject(wsDir, async ({ project }) => sourceText(project, 'pages/Home.tsx'))
    expect(text).toContain('one')
  })

  it('prewarmWorkspaceProgram really builds the program and checker, off the caller path', async () => {
    // `project.getTypeChecker()` alone is a lazy ts-morph wrapper: a prewarm
    // that stopped there built nothing, and the first edit after a cache-hit
    // load paid the whole program (P6-B: 0.37 s -> 1.7 s on a 40-page board).
    // Observed through the binder: creating the checker binds every file,
    // which sets the compiler node's `locals`.
    const bound = (project: Project) =>
      (project.getSourceFileOrThrow(path.join(wsDir, 'pages', 'Home.tsx')).compilerNode as { locals?: unknown }).locals !== undefined
    expect(await withWorkspaceProject(wsDir, async ({ project }) => bound(project))).toBe(false)
    prewarmWorkspaceProgram(wsDir)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Queued behind the prewarm, so it has finished by the time this runs.
    expect(await withWorkspaceProject(wsDir, async ({ project }) => bound(project))).toBe(true)
  })
})
