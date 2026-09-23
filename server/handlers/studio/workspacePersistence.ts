/**
 * workspacePersistence — boot-time preparation of the workspace root: create
 * it when missing, and warn when it will not survive the container it lives
 * in.
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
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { projectsRootDir } from '../studioProjects'

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

/**
 * The decision, transport-free: the warning to log for a workspace root at
 * `workspaceRoot` (an absolute POSIX path, symlinks already resolved), or
 * `null` when it is on storage that survives a restart.
 */
export function workspacePersistenceWarning(workspaceRoot: string, mountInfoText: string): string | null {
  const mount = coveringMount(posix.normalize(workspaceRoot), parseMountInfo(mountInfoText))
  if (mount === null) return null
  const fix =
    'Mount a volume there, or set STUDIO_WORKSPACE_DIR to a directory on a mounted volume. ' +
    'Before recreating this container, copy the existing projects out first: see docs/deployment/backup-restore.md, ' +
    '"Moving the workspace onto a volume".'
  if (mount.mountPoint === '/' && WRITABLE_LAYER_FS_TYPES.has(mount.fsType)) {
    return (
      `The Studio workspace root ${workspaceRoot} is on the container's writable layer, not on a mounted volume. ` +
      `Every project in it is DELETED when this container is recreated (for example on an upgrade). ${fix}`
    )
  }
  if (mount.fsType === 'tmpfs') {
    return (
      `The Studio workspace root ${workspaceRoot} is on a tmpfs mount (${mount.mountPoint}), which is held in memory. ` +
      `Every project in it is lost on restart. ${fix}`
    )
  }
  return null
}

/**
 * `path` with symlinks resolved on the part of it that exists. The root may
 * not exist yet on a first boot; the mount it WILL be created on is the one
 * covering its nearest existing ancestor.
 */
function realpathOfNearestExisting(path: string): string {
  let existing = path
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return path
    missing.unshift(basename(existing))
    existing = parent
  }
  return join(realpathSync(existing), ...missing)
}

/**
 * Boot hook. Creates the workspace root when it is missing (a fresh platform
 * disk has no `studio-workspace/` subdirectory yet, and every containment
 * guard resolves against the root's real path, which a missing directory does
 * not have), then logs `workspacePersistenceWarning` for it. Never throws: a
 * failure here is logged and boot carries on.
 */
export function prepareWorkspaceRoot(): void {
  const configuredRoot = projectsRootDir()
  try {
    mkdirSync(configuredRoot, { recursive: true })
  } catch (err) {
    console.error('[studio:workspace] Could not create the workspace root:', err)
  }
  if (process.platform !== 'linux' || !existsSync(MOUNTINFO_PATH)) return
  try {
    const root = realpathOfNearestExisting(configuredRoot)
    const warning = workspacePersistenceWarning(root, readFileSync(MOUNTINFO_PATH, 'utf-8'))
    if (warning !== null) console.warn('[studio:workspace]', warning)
  } catch (err) {
    // A diagnostic must never block boot; say it could not run and move on.
    console.error('[studio:workspace] Could not check whether the workspace root is on persistent storage:', err)
  }
}
