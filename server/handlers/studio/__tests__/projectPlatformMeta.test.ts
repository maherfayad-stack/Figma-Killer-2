/**
 * projectPlatformMeta — `.studio/meta.json` must persist the form factor a
 * project was created for, and the frame size that answer implies.
 *
 * `StudioMetaSchema` validates the WHOLE file and `parseJsonWithFallback`
 * drops a file that fails validation to `{}`. So a field the schema does not
 * declare is not merely ignored — writing one would be silently discarded on
 * the next read, and every screen in a project created as Mobile would quietly
 * open at the desktop default with nothing on disk explaining why. This pins
 * both fields against that.
 *
 * The HTTP route (`POST /admin/api/studio/create`) is deliberately NOT
 * exercised here: it derives its target from `process.cwd()/studio-workspace`,
 * so a route test would scaffold real folders into the repo's own dogfooding
 * projects. See `STATE.md`'s `store-02` for why that directory is treated as
 * live user data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { frameDefaultsForPlatform } from '@core/studio-board'
import { readStudioMeta, writeStudioMeta } from '../studioMeta'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-platform-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('project platform in .studio/meta.json', () => {
  it('round-trips a mobile project with the frame defaults it implies', () => {
    writeStudioMeta(tmpDir, {
      displayName: 'Untitled',
      platform: 'mobile',
      frameDefaults: frameDefaultsForPlatform('mobile'),
    })
    const meta = readStudioMeta(tmpDir)
    expect(meta.platform).toBe('mobile')
    expect(meta.frameDefaults).toEqual({ width: 393, height: 852 })
  })

  it('round-trips a web project', () => {
    writeStudioMeta(tmpDir, {
      displayName: 'Untitled',
      platform: 'web',
      frameDefaults: frameDefaultsForPlatform('web'),
    })
    const meta = readStudioMeta(tmpDir)
    expect(meta.platform).toBe('web')
    expect(meta.frameDefaults).toEqual({ width: 1440, height: 1024 })
  })

  it('a project with no recorded platform still reads — every pre-existing project and every GitHub import has none', () => {
    writeStudioMeta(tmpDir, { displayName: 'Legacy' })
    const meta = readStudioMeta(tmpDir)
    expect(meta.displayName).toBe('Legacy')
    expect(meta.platform).toBeUndefined()
  })

  it('an unknown platform value fails validation and degrades the whole meta to defaults, rather than being trusted', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.studio', 'meta.json'),
      JSON.stringify({ displayName: 'X', platform: 'watch' }),
    )
    expect(readStudioMeta(tmpDir).platform).toBeUndefined()
  })
})
