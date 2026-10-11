/**
 * workspaceRootGuard.ts: the boot refusal for a workspace root (or private
 * data root) that would expose the database, uploads, Studio's own code or
 * its secrets as "projects" (P1-H security review F1), and for a malformed
 * setting (F8). Every case builds a real directory layout in a temp dir and
 * resolves it the way boot does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { assertWorkspaceLayoutSafe, dirConflicts, WorkspaceRootRefusal, type WorkspaceLayoutInput } from '../workspaceRootGuard'

let base: string
/** Studio's working directory in the fake container: `<base>/app`, with code dirs in it. */
let app: string
/** The single-volume mount root: `<base>/app/storage`, holding `data/cms.db` and `uploads/`. */
let storage: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ws-root-guard-'))
  app = join(base, 'app')
  storage = join(app, 'storage')
  for (const dir of ['server', 'src', 'node_modules', 'dist', join('storage', 'data'), join('storage', 'uploads')]) {
    mkdirSync(join(app, dir), { recursive: true })
  }
  writeFileSync(join(storage, 'data', 'cms.db'), '')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** The Railway/Render single-volume layout, with the workspace and data roots overridable. */
function singleVolume(env: Record<string, string | undefined>): WorkspaceLayoutInput {
  return {
    cwd: app,
    config: {
      databaseUrl: `sqlite:${join(storage, 'data', 'cms.db')}`,
      uploadsDir: join(storage, 'uploads'),
      staticDir: join(app, 'dist'),
    },
    env: { STUDIO_DATA_DIR: join(storage, '.data'), ...env },
  }
}

function refusal(input: WorkspaceLayoutInput): string {
  try {
    assertWorkspaceLayoutSafe(input)
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceRootRefusal)
    return (err as WorkspaceRootRefusal).message
  }
  throw new Error('expected assertWorkspaceLayoutSafe to refuse')
}

describe('assertWorkspaceLayoutSafe: layouts that must boot', () => {
  it('accepts the documented single-volume layout (a dedicated subdirectory of the mount)', () => {
    const layout = assertWorkspaceLayoutSafe(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'studio-workspace') }))
    expect(layout.workspaceRoot).toBe(join(storage, 'studio-workspace'))
    expect(layout.dataRoot).toBe(join(storage, '.data'))
  })

  it('accepts the image default: <cwd>/studio-workspace, on its own volume', () => {
    expect(() => assertWorkspaceLayoutSafe(singleVolume({ STUDIO_WORKSPACE_DIR: join(app, 'studio-workspace') }))).not.toThrow()
  })

  it('accepts an unset workspace setting (the dev checkout: <cwd>/studio-workspace)', () => {
    expect(assertWorkspaceLayoutSafe(singleVolume({})).workspaceRoot).toBe(join(app, 'studio-workspace'))
  })

  it('accepts a workspace root inside the database directory (the e2e stack keeps both under .tmp/)', () => {
    expect(() => assertWorkspaceLayoutSafe(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'data', 'ws') }))).not.toThrow()
  })
})

describe('assertWorkspaceLayoutSafe: F1, a root that would turn protected state into projects', () => {
  it('refuses the single-volume MOUNT ROOT, which holds data/cms.db and uploads/ (the reproduced case)', () => {
    const message = refusal(singleVolume({ STUDIO_WORKSPACE_DIR: storage }))
    expect(message).toContain("the SQLite database's directory")
    expect(message).toContain('the uploads directory (UPLOADS_DIR)')
    expect(message).toContain('DEDICATED directory')
  })

  it("refuses Studio's own working directory (its code)", () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: app }))).toContain("Studio's working directory")
  })

  it('refuses the filesystem root', () => {
    const fsRoot = parse(app).root
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: fsRoot }))).toContain('contains')
  })

  it('refuses the database directory itself', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'data') }))).toContain("is the SQLite database's directory")
  })

  it('refuses a root inside uploads (served over HTTP)', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'uploads', 'ws') }))).toContain('is inside the uploads directory')
  })

  it('refuses a root inside the built admin app (served over HTTP)', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(app, 'dist', 'ws') }))).toContain('STATIC_DIR')
  })

  it("refuses a root inside Studio's server/ code", () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(app, 'server', 'ws') }))).toContain("Studio's server/")
  })

  it('refuses a root that is, or holds, the private data root', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, '.data') }))).toContain('STUDIO_DATA_DIR')
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'ws'), STUDIO_DATA_DIR: join(storage, 'ws', 'private') }))).toContain('STUDIO_DATA_DIR')
  })

  it('refuses a root that reaches the mount root through a symlink (checked on the real path)', () => {
    const link = join(base, 'innocent-looking')
    symlinkSync(storage, link, 'junction')
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: link }))).toContain("the SQLite database's directory")
  })

  it('refuses a private data root inside uploads (it holds secrets)', () => {
    expect(
      refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'studio-workspace'), STUDIO_DATA_DIR: join(storage, 'uploads', 'private') })),
    ).toContain('The private data root (STUDIO_DATA_DIR)')
  })
})

describe('assertWorkspaceLayoutSafe: F8, a malformed setting refuses instead of resolving silently', () => {
  it('refuses a whitespace-only STUDIO_WORKSPACE_DIR', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: '   ' }))).toContain('STUDIO_WORKSPACE_DIR is set but blank')
  })

  it('refuses a relative STUDIO_WORKSPACE_DIR', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join('rel', 'ws') }))).toContain('must be an absolute directory path')
  })

  it('refuses a padded STUDIO_WORKSPACE_DIR rather than trimming it into a different directory', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: ` ${join(storage, 'studio-workspace')}` }))).toContain('whitespace')
  })

  it('refuses a relative STUDIO_DATA_DIR', () => {
    expect(refusal(singleVolume({ STUDIO_WORKSPACE_DIR: join(storage, 'ws'), STUDIO_DATA_DIR: '.data' }))).toContain('STUDIO_DATA_DIR must be an absolute')
  })
})

describe('dirConflicts (pure)', () => {
  it('compares whole path segments, not string prefixes', () => {
    expect(dirConflicts('root', '/app/storage-ws', [{ label: 'storage', path: '/app/storage', rule: 'must-not-overlap' }])).toEqual([])
    expect(dirConflicts('root', '/app/stor', [{ label: 'storage', path: '/app/storage', rule: 'must-not-overlap' }])).toEqual([])
  })

  it('treats must-not-contain as one-directional', () => {
    expect(dirConflicts('root', '/app/studio-workspace', [{ label: 'code', path: '/app', rule: 'must-not-contain' }])).toEqual([])
    expect(dirConflicts('root', '/', [{ label: 'code', path: '/app', rule: 'must-not-contain' }])).toHaveLength(1)
  })

  it('treats must-not-overlap as both directions', () => {
    const uploads = { label: 'uploads', path: '/app/uploads', rule: 'must-not-overlap' as const }
    expect(dirConflicts('root', '/app/uploads/ws', [uploads])).toHaveLength(1)
    expect(dirConflicts('root', '/app', [uploads])).toHaveLength(1)
  })
})
