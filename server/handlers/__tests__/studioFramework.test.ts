/**
 * studioFramework — `.studio/framework.json` read/write round trip.
 * Driven against a temp fixture dir, same pattern as `studio.test.ts`'s
 * `listStudioProjects`/`POST /admin/api/studio/page` suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readStudioFrameworkFile, writeStudioFrameworkFile } from '../studioFramework'
import type { FrameworkSettings } from '@core/framework-schema'

const VALID_FRAMEWORK: FrameworkSettings = { colors: { tokens: [] } }

describe('studioFramework', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-framework-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no framework.json exists yet', () => {
    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })

  it('writes a valid framework and reads it back unchanged', () => {
    const written = writeStudioFrameworkFile(tmpDir, VALID_FRAMEWORK)
    expect(written).toMatchObject({ ok: true })

    const read = readStudioFrameworkFile(tmpDir)
    expect(read).toEqual(VALID_FRAMEWORK)

    // Written to the expected sidecar path.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(true)
  })

  it('rejects an invalid shape on write (missing required colors field)', () => {
    const result = writeStudioFrameworkFile(tmpDir, { typography: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    // Nothing was written.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(false)
  })

  it('overwrites a previous valid write with a new one', () => {
    writeStudioFrameworkFile(tmpDir, VALID_FRAMEWORK)
    const updated: FrameworkSettings = {
      colors: {
        tokens: [
          {
            id: 't1', category: 'brand', slug: 'brand-500', lightValue: '#4f46e5', darkValue: '#4f46e5',
            darkModeEnabled: false,
            generateUtilities: { text: true, background: true, border: true, fill: false },
            generateTransparent: false,
            generateShades: { enabled: false, count: 5 },
            generateTints: { enabled: false, count: 5 },
            order: 0, createdAt: 0, updatedAt: 0,
          },
        ],
      },
    }
    writeStudioFrameworkFile(tmpDir, updated)

    const read = readStudioFrameworkFile(tmpDir)
    expect(read?.colors.tokens).toHaveLength(1)
    expect(read?.colors.tokens[0].slug).toBe('brand-500')
  })

  it('returns null (soft-fallback) for a corrupted framework.json already on disk', () => {
    const file = path.join(tmpDir, '.studio', 'framework.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'not valid json {{{')

    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })

  it('returns null (soft-fallback) for well-formed JSON that does not match the schema', () => {
    const file = path.join(tmpDir, '.studio', 'framework.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ nope: true }))

    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })
})
