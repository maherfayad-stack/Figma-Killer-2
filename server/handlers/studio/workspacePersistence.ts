/**
 * workspacePersistence — boot-time preparation of the workspace root: refuse
 * an unsafe layout (`workspaceRootGuard.ts`), create the root when missing,
 * and warn when it, or Studio's private data root, will not survive the
 * container it lives in.
 *
 * The workspace root (`projectsRootDir()`) holds every user's real React
 * projects, Studio's source of truth, with no other copy. In a container it
 * must sit on a mounted volume: anything written to the container's own
 * writable layer is deleted the moment the container is recreated, which
 * `docker compose pull && docker compose up -d` does on every upgrade. The
 * shipped image, Compose files and platform templates all mount it (P1-H;
 * gated by `workspace-volume-persistence.test.ts`), but an operator running
 * an older Compose file, a hand-written `docker run`, or a platform service
 * created before the template changed can still be on the writable layer.
 * This makes that visible in the boot log instead of on the day the projects
 * disappear.
 *
 * ## How it decides, and why only this
 *
 * Linux publishes every mount the process can see in `/proc/self/mountinfo`.
 * The mount that covers a path is the one with the longest mount point that
 * is a path-segment prefix of it. The warning fires only when that covering
 * mount is:
 *
 *   - `/` itself, with an overlay filesystem type: the container's writable
 *     layer (Docker's and Podman's default storage drivers), or
 *   - a `tmpfs`: memory, gone on every restart.
 *
 * A volume, a bind mount or a platform disk shows up as its own mount entry
 * (`ext4`, `xfs`, …) at or above the root, so it never warns. A bare-metal or
 * VM install has a real filesystem at `/`, so it never warns either. Other
 * storage drivers (btrfs, zfs, devicemapper) are not recognised as a writable
 * layer, so they stay silent: a missed warning is acceptable, a false alarm on
 * a correctly mounted install is not. Non-Linux hosts have no mountinfo and
 * are skipped.
 *
 * It only ever LOGS. Refusing to boot would take down an install that is
 * working today over a storage layout the operator may have chosen on purpose.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { DATA_DIR_ENV, WORKSPACE_DIR_ENV } from '../../runtimeDirs'
import { assertWorkspaceLayoutSafe, type WorkspaceLayout, type WorkspaceLayoutInput } from './workspaceRootGuard'
import { realpathAllowingMissing } from './workspacePackageResolve'

const MOUNTINFO_PATH = '/proc/self/mountinfo'

/** Filesystem types a container runtime uses for the container's own root, i.e. its writable layer. */
const WRITABLE_LAYER_FS_TYPES = new Set(['overlay', 'fuse.fuse-overlayfs', 'aufs'])

export interface MountEntry {
  mountPoint: string
  fsType: string
}

/** Mount points escape space, tab, newline and backslash as three-digit octal (`\040`). */
function decodeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/**
 * Parses `/proc/self/mountinfo` (see proc(5)). Each line is
 * `id parent major:minor root mountPoint options [optional…] - fsType source superOptions`;
 * the optional fields vary in number, so the filesystem type is found after
 * the lone `-` separator rather than at a fixed index. Malformed lines are
 * skipped.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ')
    if (fields.length < 7) continue
    const separator = fields.indexOf('-', 6)
    if (separator === -1 || separator + 1 >= fields.length) continue
    entries.push({ mountPoint: decodeMountPath(fields[4]), fsType: fields[separator + 1] })
  }
  return entries
}

/** True when `mountPoint` is `path` or one of its ancestors, compared on whole path segments. */
function mountCovers(mountPoint: string, path: string): boolean {
  if (mountPoint === '/') return true
  return path === mountPoint || path.startsWith(`${mountPoint}/`)
}

/**
 * The mount a path lives on: the longest covering mount point, and among
 * equal mount points the LAST entry, since a later mount stacks on top of an
 * earlier one at the same place.
 */
export function coveringMount(path: string, mounts: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null
  for (const mount of mounts) {
    if (!mountCovers(mount.mountPoint, path)) continue
    if (best === null || mount.mountPoint.length >= best.mountPoint.length) best = mount
  }
  return best
}

/** What a persistence warning is about: the root, what lives in it, and the variable that moves it. */
export interface PersistedRoot {
  /** e.g. "Studio workspace root". */
  name: string
  /** e.g. "Every project in it". */
  contents: string
  variable: string
}

export const WORKSPACE_ROOT_SUBJECT: PersistedRoot = {
  name: 'Studio workspace root',
  contents: 'Every project in it',
  variable: WORKSPACE_DIR_ENV,
}

export const DATA_ROOT_SUBJECT: PersistedRoot = {
  name: "Studio's private data root",
  contents: 'The MCP server secrets and Claude CLI logins in it',
  variable: DATA_DIR_ENV,
}

/**
 * The decision, transport-free: the warning to log for `subject` at `root`
 * (an absolute POSIX path, symlinks already resolved), or `null` when it is on
 * storage that survives a restart.
 */
export function persistenceWarning(subject: PersistedRoot, root: string, mountInfoText: string): string | null {
  const mount = coveringMount(posix.normalize(root), parseMountInfo(mountInfoText))
  if (mount === null) return null
  const fix =
    `Mount a volume there, or set ${subject.variable} to a directory on a mounted volume. ` +
    'Before recreating this container, copy the existing contents out first: see docs/deployment/backup-restore.md, ' +
    '"Moving the workspace onto a volume".'
  if (mount.mountPoint === '/' && WRITABLE_LAYER_FS_TYPES.has(mount.fsType)) {
    return (
      `The ${subject.name} ${root} is on the container's writable layer, not on a mounted volume. ` +
      `${subject.contents} is DELETED when this container is recreated (for example on an upgrade). ${fix}`
    )
  }
  if (mount.fsType === 'tmpfs') {
    return (
      `The ${subject.name} ${root} is on a tmpfs mount (${mount.mountPoint}), which is held in memory. ` +
      `${subject.contents} is lost on restart. ${fix}`
    )
  }
  return null
}

export interface PrepareWorkspaceRootInput extends WorkspaceLayoutInput {
  /** Defaults to `process.platform`; the mount check runs on Linux only. */
  platform?: NodeJS.Platform
  /** The mount table text, or `null` when there is none. Defaults to reading `/proc/self/mountinfo`. */
  readMountInfo?: () => string | null
  /** Defaults to `console`. */
  log?: Pick<Console, 'warn' | 'error'>
}

function readProcMountInfo(): string | null {
  return existsSync(MOUNTINFO_PATH) ? readFileSync(MOUNTINFO_PATH, 'utf-8') : null
}

/**
 * Boot hook, called once from `server/index.ts` before the database opens.
 *
 *   1. `assertWorkspaceLayoutSafe`: THROWS `WorkspaceRootRefusal` on a
 *      malformed setting or an unsafe layout. The caller logs it and exits.
 *   2. Creates the workspace root when it is missing (a fresh platform disk
 *      has no `studio-workspace/` yet, and every containment guard resolves
 *      against the root's real path, which a missing directory does not
 *      have). A failure is logged, not thrown.
 *   3. On Linux, logs `persistenceWarning` for the workspace root and the
 *      private data root. Never throws.
 */
export function prepareWorkspaceRoot(input: PrepareWorkspaceRootInput): WorkspaceLayout {
  const log = input.log ?? console
  const layout = assertWorkspaceLayoutSafe(input)
  try {
    mkdirSync(layout.workspaceRoot, { recursive: true })
  } catch (err) {
    log.error('[studio:workspace] Could not create the workspace root:', err)
  }
  if ((input.platform ?? process.platform) !== 'linux') return layout
  try {
    const mountInfo = (input.readMountInfo ?? readProcMountInfo)()
    if (mountInfo === null) return layout
    for (const [subject, root] of [
      [WORKSPACE_ROOT_SUBJECT, layout.workspaceRoot],
      [DATA_ROOT_SUBJECT, layout.dataRoot],
    ] as const) {
      const warning = persistenceWarning(subject, realpathAllowingMissing(root), mountInfo)
      if (warning !== null) log.warn('[studio:workspace]', warning)
    }
  } catch (err) {
    // A diagnostic must never block boot; say it could not run and move on.
    log.error('[studio:workspace] Could not check whether the workspace root is on persistent storage:', err)
  }
  return layout
}
