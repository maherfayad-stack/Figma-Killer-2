/**
 * `withWorkspaceProject` — the kept ts-morph `Project` behind every load.
 *
 * What a caller may rely on: the same `Project` comes back across calls, and
 * before each call it reflects the disk — an edited file is re-read, a new
 * file is present, a deleted file is gone, an in-memory file a previous
 * caller created is gone — and two callers never run at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Project } from 'ts-morph'
import { projectsRootDir } from '../studioProjects'
import { clearWorkspaceProjects, withWorkspaceProject } from '../studio/workspaceProject'

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
    fs.rmSync(wsDir, { recursive: true, force: true })
    clearWorkspaceProjects()
  })

  it('hands back the SAME Project across calls, without the preview shell in it', async () => {
    const first = await withWorkspaceProject(wsDir, async (project) => project)
    const second = await withWorkspaceProject(wsDir, async (project) => project)
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

    const text = await withWorkspaceProject(wsDir, async (project) => sourceText(project, 'pages/Home.tsx'))
    expect(text).toContain('two')
    expect(text).not.toContain('one')
  })

  it('adds a new file and drops a deleted one', async () => {
    await withWorkspaceProject(wsDir, async () => undefined)
    write('pages/About.tsx', 'export default function About() { return <div>about</div> }\n')
    fs.rmSync(path.join(wsDir, 'pages', 'Home.tsx'))

    const [about, home] = await withWorkspaceProject(wsDir, async (project) => [
      sourceText(project, 'pages/About.tsx'),
      sourceText(project, 'pages/Home.tsx'),
    ])
    expect(about).toContain('about')
    expect(home).toBeUndefined()
  })

  it('drops an in-memory file a previous caller created on the shared Project', async () => {
    await withWorkspaceProject(wsDir, async (project) => {
      project.createSourceFile(path.join(wsDir, 'scan.tsx'), 'export const x = 1\n')
    })
    const stillThere = await withWorkspaceProject(wsDir, async (project) => sourceText(project, 'scan.tsx'))
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
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('a caller that throws does not wedge the queue', async () => {
    await expect(withWorkspaceProject(wsDir, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const text = await withWorkspaceProject(wsDir, async (project) => sourceText(project, 'pages/Home.tsx'))
    expect(text).toContain('one')
  })
})
