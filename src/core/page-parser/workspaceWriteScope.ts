/**
 * workspaceWriteScope — the ONE answer to "may Studio write this path inside a
 * user's project?", for every writer: the writeback codemods, the CSS
 * writeback, asset landing, the component-copy codemods, and the agent's
 * native `Write`/`Edit` hook.
 *
 * ## Why one predicate
 *
 * `EXCLUDED_WORKSPACE_DIR_NAMES` already said which directories in a project
 * are not the user's source, but each writer re-implemented the check with
 * its own `segments.some(...)`, and they drifted: the node-id writeback
 * (`isWritableSourceRel`) never consulted the list at all, so
 * `.studio/anything.tsx:1:1` was a valid write target; the CSS and asset
 * writers checked it only on the TEXTUAL path, so a symlink named like source
 * (`src/theme -> ../.studio`) carried a write straight into Studio's control
 * plane; and every one of them compared case-sensitively on filesystems that
 * are not.
 *
 * ## What it refuses
 *
 * {@link UNWRITABLE_WORKSPACE_DIR_NAMES}: every walk exclusion plus `.claude`.
 * `.studio` is Studio's consent record (the `trust` tier, MCP-server
 * approvals), `.claude` holds the generated hook settings that enforce the
 * agent's own write gate, `.git` is executable by proxy (`hooks/`), and
 * `node_modules`/build output is not source. A segment is compared the way
 * the filesystem will resolve it: case-folded (Windows, default macOS), with
 * trailing dots/spaces dropped and an NTFS stream suffix cut off — `.STUDIO`,
 * `.studio.` and `.git::$INDEX_ALLOCATION` all open the directory they
 * spell.
 *
 * ## Lexical AND real
 *
 * {@link unwritableWorkspaceSegment} is the pure half, for callers that must
 * stay pure (`isWritableSourceRel`). {@link isWorkspaceWritablePath} adds the
 * real-path half: it resolves symlinks and junctions (git stores symlinks, so
 * an imported repository can carry one) and re-applies the same segment rule
 * to where the write would actually land. Either hit refuses.
 *
 * A path that passes through a DANGLING symlink has no real path, and is
 * refused rather than treated as "not created yet": `writeFileSync` follows
 * the link, so a new-file writer checking the link's own spelling would
 * create the file wherever the link points — outside the project included.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from './workspaceFiles'

/**
 * Directory names no Studio write may land in, at any depth: the walk
 * exclusions plus `.claude`. Derived from `EXCLUDED_WORKSPACE_DIR_NAMES`, so a
 * future exclusion reaches every writer without anyone remembering to come
 * here. `.claude` is not a walk exclusion — the parser may read it — only a
 * write exclusion.
 */
export const UNWRITABLE_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set<string>([
  ...EXCLUDED_WORKSPACE_DIR_NAMES,
  '.claude',
])

/** A path segment as the filesystem will resolve it, for comparison only. */
function comparableSegment(segment: string): string {
  const withoutStream = segment.split(':')[0] ?? segment
  return withoutStream.replace(/[. ]+$/, '').toLowerCase()
}

/**
 * The first segment of a project-relative path (either separator) that names
 * an unwritable directory, or `null`. Pure: no filesystem access, so it can
 * sit inside a lexical guard. The last segment counts too — a FILE named
 * `.git` is a gitdir pointer, and rewriting it re-targets the repository.
 */
export function unwritableWorkspaceSegment(rel: string): string | null {
  return firstSegmentNamedIn(rel, UNWRITABLE_WORKSPACE_DIR_NAMES)
}

/**
 * The READ-side twin of {@link unwritableWorkspaceSegment}: the first segment
 * naming a directory no Studio walk or agent read enters
 * (`EXCLUDED_WORKSPACE_DIR_NAMES` — `.studio`, `.git`, `node_modules`, build
 * output), compared the same filesystem way. `.claude` is deliberately
 * readable: it holds the design-system reference files the agent is told to
 * read. Pure, like its twin.
 */
export function excludedWorkspaceSegment(rel: string): string | null {
  return firstSegmentNamedIn(rel, EXCLUDED_WORKSPACE_DIR_NAMES)
}

function firstSegmentNamedIn(rel: string, names: ReadonlySet<string>): string | null {
  for (const segment of rel.split(/[\\/]+/)) {
    if (names.has(comparableSegment(segment))) return segment
  }
  return null
}

/**
 * Whether a file NAME (the last segment) is one that conventionally holds a
 * credential: `.env` and its variants (but not the committed `.example` /
 * `.sample` / `.template` shapes), package-manager and network auth files, and
 * private-key material. Compared the filesystem way, like the directory sets.
 *
 * No agent file tool reads or writes one. A tool result is a transcript line a
 * provider stores; a key in it has left the machine.
 */
export function isSecretBearingFileName(name: string): boolean {
  const comparable = comparableSegment(name)
  if (comparable === '.env') return true
  if (comparable.startsWith('.env.')) return !PUBLIC_ENV_SUFFIXES.has(comparable.slice('.env.'.length))
  if (SECRET_FILE_NAMES.has(comparable)) return true
  return SECRET_FILE_EXTENSIONS.some((ext) => comparable.endsWith(ext))
}

const PUBLIC_ENV_SUFFIXES: ReadonlySet<string> = new Set(['example', 'sample', 'template', 'defaults'])
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.yarnrc.yml',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])
const SECRET_FILE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx']

/**
 * The real path of `path` — symlinks and junctions resolved, on-disk casing
 * restored — through the DEEPEST ancestor that exists, with the missing tail
 * re-appended. `null` when a component exists but cannot be resolved: a
 * dangling symlink (which a write would follow) or an unreadable entry.
 *
 * `realpathSync.native` is the OS call, which returns the on-disk casing and
 * expands 8.3 short names; the JS implementation does neither.
 */
export function realpathAllowingMissing(path: string): string | null {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      if (pathEntryExists(current)) return null
      const parent = dirname(current)
      // The filesystem root always exists; reaching it without a hit means
      // nothing along the path could be resolved — fail closed.
      if (parent === current) return null
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Whether ANY directory entry exists at `path`, links not followed — true for
 * a dangling symlink, which `existsSync` (links followed) reports as absent.
 * The question a new-file writer must ask: an exclusive create (`wx`) is not
 * enough on its own, because on Windows it follows a dangling link and
 * creates the file at the link's target.
 */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * `target`'s real path relative to `root`'s real path, POSIX-separated, or
 * `null` when it is not strictly inside `root` (escapes through `..`, is on
 * another drive, is `root` itself) or cannot be resolved at all.
 */
export function realWorkspaceRel(root: string, target: string): string | null {
  const realRoot = realpathAllowingMissing(root)
  const realTarget = realpathAllowingMissing(target)
  if (realRoot === null || realTarget === null) return null
  const rel = relative(realRoot, realTarget)
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/**
 * Whether `target` (absolute) is a path Studio may write inside the project at
 * `root`: strictly inside it both textually and on the real path, with no
 * unwritable directory on either. The one predicate every writer that builds
 * its own absolute path consults; see this module's doc.
 */
export function isWorkspaceWritablePath(root: string, target: string): boolean {
  const lexical = relative(resolve(root), resolve(target))
  if (lexical === '' || isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`)) return false
  if (unwritableWorkspaceSegment(lexical) !== null) return false
  const real = realWorkspaceRel(root, target)
  return real !== null && unwritableWorkspaceSegment(real) === null
}
