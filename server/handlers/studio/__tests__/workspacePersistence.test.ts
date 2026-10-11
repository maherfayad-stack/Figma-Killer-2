/**
 * workspacePersistence.ts: the boot warning for a workspace root that will
 * not survive a container recreate (P1-H). The decision is pure over the
 * mountinfo text, so each case below is a real-shaped `/proc/self/mountinfo`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coveringMount,
  DATA_ROOT_SUBJECT,
  parseMountInfo,
  persistenceWarning,
  prepareWorkspaceRoot,
  type PrepareWorkspaceRootInput,
  WORKSPACE_ROOT_SUBJECT,
} from '../workspacePersistence'
import { WorkspaceRootRefusal } from '../workspaceRootGuard'

/** Docker's container root, the writable layer. */
const OVERLAY_ROOT =
  '553 460 0:48 / / rw,relatime master:245 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/x/diff,workdir=/var/lib/docker/overlay2/x/work'
const PROC = '554 553 0:52 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw'
const ETC_HOSTS = '570 553 259:2 /var/lib/docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/nvme0n1p2 rw'

function volumeAt(mountPoint: string, id = 571): string {
  return `${id} 553 259:2 /var/lib/docker/volumes/studio-prod_workspace/_data ${mountPoint} rw,relatime master:1 - ext4 /dev/nvme0n1p2 rw`
}

function mountinfo(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

describe('parseMountInfo', () => {
  it('reads the mount point and the filesystem type after the `-` separator, whatever the optional fields', () => {
    expect(parseMountInfo(mountinfo(OVERLAY_ROOT, PROC, volumeAt('/app/studio-workspace')))).toEqual([
      { mountPoint: '/', fsType: 'overlay' },
      { mountPoint: '/proc', fsType: 'proc' },
      { mountPoint: '/app/studio-workspace', fsType: 'ext4' },
    ])
  })

  it('decodes octal-escaped characters in a mount point', () => {
    const [entry] = parseMountInfo('600 553 259:2 / /mnt/my\\040projects rw - ext4 /dev/sda1 rw')
    expect(entry.mountPoint).toBe('/mnt/my projects')
  })

  it('skips malformed and empty lines', () => {
    expect(parseMountInfo('\ngarbage\n1 2 3 4 /x rw no-separator-here\n')).toEqual([])
  })
})

describe('coveringMount', () => {
  const mounts = parseMountInfo(mountinfo(OVERLAY_ROOT, volumeAt('/app/studio')))

  it('matches on whole path segments: a mount at /app/studio does not cover /app/studio-workspace', () => {
    expect(coveringMount('/app/studio-workspace', mounts)?.mountPoint).toBe('/')
    expect(coveringMount('/app/studio/x', mounts)?.mountPoint).toBe('/app/studio')
  })

  it('takes the later of two mounts at the same point (the one stacked on top)', () => {
    const stacked = parseMountInfo(
      mountinfo(OVERLAY_ROOT, volumeAt('/app/studio-workspace'), '700 553 0:60 / /app/studio-workspace rw - tmpfs tmpfs rw'),
    )
    expect(coveringMount('/app/studio-workspace', stacked)?.fsType).toBe('tmpfs')
  })
})

describe('persistenceWarning', () => {
  const workspacePersistenceWarning = (root: string, text: string) => persistenceWarning(WORKSPACE_ROOT_SUBJECT, root, text)

  it('warns when the root is on the container writable layer (the shipped-image bug P1-H fixes)', () => {
    const warning = workspacePersistenceWarning('/app/studio-workspace', mountinfo(OVERLAY_ROOT, PROC, ETC_HOSTS))
    expect(warning).toContain('writable layer')
    expect(warning).toContain('/app/studio-workspace')
    expect(warning).toContain('STUDIO_WORKSPACE_DIR')
  })

  it('is silent when a volume is mounted exactly at the root', () => {
    expect(workspacePersistenceWarning('/app/studio-workspace', mountinfo(OVERLAY_ROOT, volumeAt('/app/studio-workspace')))).toBeNull()
  })

  it('is silent when the root is inside a mounted volume (the Railway/Render /app/storage layout)', () => {
    expect(workspacePersistenceWarning('/app/storage/studio-workspace', mountinfo(OVERLAY_ROOT, volumeAt('/app/storage')))).toBeNull()
  })

  it('still warns when the only nearby volume is a sibling with a shared name prefix', () => {
    expect(workspacePersistenceWarning('/app/studio-workspace', mountinfo(OVERLAY_ROOT, volumeAt('/app/studio')))).not.toBeNull()
  })

  it('warns for a tmpfs root', () => {
    const warning = workspacePersistenceWarning(
      '/app/studio-workspace',
      mountinfo(OVERLAY_ROOT, '700 553 0:60 / /app/studio-workspace rw - tmpfs tmpfs rw'),
    )
    expect(warning).toContain('tmpfs')
  })

  it('is silent on a bare-metal or VM host whose / is a real filesystem', () => {
    expect(workspacePersistenceWarning('/home/me/studio/studio-workspace', mountinfo('22 1 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw'))).toBeNull()
  })

  it('is silent when the mount table is unreadable or empty (never a false alarm)', () => {
    expect(workspacePersistenceWarning('/app/studio-workspace', '')).toBeNull()
  })

  it('names the private data root and its own variable when that is the subject', () => {
    const warning = persistenceWarning(DATA_ROOT_SUBJECT, '/app/.data', mountinfo(OVERLAY_ROOT))
    expect(warning).toContain("Studio's private data root /app/.data")
    expect(warning).toContain('STUDIO_DATA_DIR')
  })
})

// P1-H review F5: the boot hook itself. Its contract is "refuse an unsafe
// layout, otherwise never throw and never block boot".
describe('prepareWorkspaceRoot', () => {
  let base: string
  let app: string
  let warnings: unknown[][]
  let errors: unknown[][]

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'prepare-ws-root-'))
    app = join(base, 'app')
    mkdirSync(join(app, 'uploads'), { recursive: true })
    warnings = []
    errors = []
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function input(workspaceRoot: string, extra: Partial<PrepareWorkspaceRootInput> = {}): PrepareWorkspaceRootInput {
    return {
      cwd: app,
      config: { databaseUrl: 'postgres://db/studio', uploadsDir: join(app, 'uploads'), staticDir: join(app, 'dist') },
      env: { STUDIO_WORKSPACE_DIR: workspaceRoot, STUDIO_DATA_DIR: join(app, '.data') },
      platform: 'linux',
      readMountInfo: () => mountinfo(OVERLAY_ROOT),
      log: { warn: (...args: unknown[]) => warnings.push(args), error: (...args: unknown[]) => errors.push(args) },
      ...extra,
    }
  }

  it('creates a missing root, including missing parents', () => {
    const root = join(app, 'storage', 'studio-workspace')
    const layout = prepareWorkspaceRoot(input(root, { platform: 'win32' }))
    expect(layout.workspaceRoot).toBe(root)
    expect(statSync(root).isDirectory()).toBe(true)
    expect(errors).toEqual([])
  })

  it('logs, and does not throw, when the root cannot be created (its parent is a regular file)', () => {
    writeFileSync(join(app, 'blocker'), '')
    expect(() => prepareWorkspaceRoot(input(join(app, 'blocker', 'studio-workspace'), { platform: 'win32' }))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('Could not create the workspace root')
  })

  it('logs, and does not throw, when the root is itself a regular file', () => {
    writeFileSync(join(app, 'studio-workspace'), '')
    expect(() => prepareWorkspaceRoot(input(join(app, 'studio-workspace'), { platform: 'win32' }))).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('accepts a symlinked root that resolves to a safe directory, without error', () => {
    const real = join(base, 'volume', 'studio-workspace')
    mkdirSync(real, { recursive: true })
    const link = join(app, 'studio-workspace')
    symlinkSync(real, link, 'junction')
    const layout = prepareWorkspaceRoot(input(link, { platform: 'win32' }))
    expect(layout.workspaceRoot).toBe(link)
    expect(statSync(link).isDirectory()).toBe(true)
    expect(errors).toEqual([])
  })

  it('warns for both the workspace root and the private data root on a writable layer', () => {
    prepareWorkspaceRoot(input(join(app, 'studio-workspace')))
    expect(warnings.map((args) => String(args[1]))).toEqual([
      expect.stringContaining('Studio workspace root'),
      expect.stringContaining("Studio's private data root"),
    ])
  })

  it('never throws when the mount table cannot be read', () => {
    const exploding = () => {
      throw new Error('EACCES: /proc/self/mountinfo')
    }
    expect(() => prepareWorkspaceRoot(input(join(app, 'studio-workspace'), { readMountInfo: exploding }))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('skips the mount check off Linux and when there is no mount table', () => {
    prepareWorkspaceRoot(input(join(app, 'studio-workspace'), { platform: 'darwin' }))
    prepareWorkspaceRoot(input(join(app, 'studio-workspace'), { readMountInfo: () => null }))
    expect(warnings).toEqual([])
  })

  it('DOES throw a WorkspaceRootRefusal for an unsafe layout, before creating anything', () => {
    expect(() => prepareWorkspaceRoot(input(join(app, 'uploads', 'ws')))).toThrow(WorkspaceRootRefusal)
    expect(() => statSync(join(app, 'uploads', 'ws'))).toThrow()
  })
})
