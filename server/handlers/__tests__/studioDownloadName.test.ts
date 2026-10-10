/**
 * studioDownload — the zip is named after the project, never a generic
 * constant, and a missing workspace never echoes a filesystem path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildStudioDownloadResponse, downloadFileName } from '../studioDownload'
import { writeProjectMeta } from '../studioProjects'

describe('downloadFileName', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-download-name-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('names the zip after the project display name, slugified', () => {
    const dir = path.join(root, 'folder-name')
    fs.mkdirSync(dir)
    writeProjectMeta(dir, { displayName: 'My eSIM App!' })
    expect(downloadFileName(dir)).toBe('my-esim-app.zip')
  })

  it('falls back to the folder name when no display name is recorded', () => {
    const dir = path.join(root, 'test4')
    fs.mkdirSync(dir)
    expect(downloadFileName(dir)).toBe('test4.zip')
  })

  it('carries the project name in the Content-Disposition of the real response', () => {
    const dir = path.join(root, 'test4')
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return null }')
    const res = buildStudioDownloadResponse(dir)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="test4.zip"')
  })

  it('does not put the workspace path in the not-found error', async () => {
    const missing = path.join(root, 'secret-location', 'gone')
    const res = buildStudioDownloadResponse(missing)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).not.toContain('secret-location')
  })
})
