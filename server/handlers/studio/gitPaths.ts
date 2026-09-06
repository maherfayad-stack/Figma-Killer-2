/**
 * gitPaths — every string a client hands the git routes, judged before it can
 * reach an argv array.
 *
 * Three separate untrusted shapes reach `git`, and each has its own way of
 * being weaponised:
 *
 *   - a **workspace-relative file path** (`commit`'s `files`, `diff`'s `file`,
 *     `restore`'s `file`). Absolute paths, UNC paths, drive letters, `..` or
 *     empty segments on EITHER separator, and anything under
 *     `EXCLUDED_WORKSPACE_DIR_NAMES` are rejected — same rule set
 *     `studioAsset.ts` applies to an asset request, for the same reason. The
 *     lexical check is only half of it: the caller must ALSO containment-check
 *     the resolved path on its real path, because a repo arriving from GitHub
 *     carries git-stored symlinks and a textual check alone is bypassable.
 *     `resolveWorkspaceRelativePath` does both.
 *   - a **branch name**. Git's own `check-ref-format` is the real validator
 *     (a subprocess — see `gitOperations.ts`), but a name is an argv token
 *     BEFORE that runs, so a leading `-` (which `git switch`/`git branch`
 *     would read as a flag rather than a branch) and control characters are
 *     rejected here first.
 *   - a **commit sha**. Hex only, 7–40 characters. Anything else — including
 *     the revision grammar git otherwise accepts (`HEAD~3`, `@{upstream}`,
 *     `:/message`) — is refused, because the only thing the history view ever
 *     hands back is a hash it read out of `git log`.
 *
 * Nothing here interpolates into a shell string; there is no shell anywhere in
 * this feature. These guards exist because an argv array still lets a crafted
 * value pose as a FLAG, and because a path that survives argv can still escape
 * the workspace on disk.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'

/** Windows drive-letter prefix (`C:` / `c:/…`) — an absolute path that `isAbsolute` misses on POSIX. */
const DRIVE_LETTER_RE = /^[A-Za-z]:/
/**
 * Any C0/DEL control character. Newlines in particular would corrupt every
 * NUL/line-delimited git output this feature parses, and a NUL would truncate
 * an argv token.
 *
 * Written as a scan rather than a regex literal: a character class containing
 * real control characters is what `no-control-regex` exists to catch, and the
 * loop says what it means without needing the escape sequences read carefully.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Lexical judgement of a workspace-relative path — the cheap half, run before
 * anything touches the filesystem. `null` means "refuse"; a POSIX-separated,
 * normalized path means "lexically acceptable, now check containment".
 */
export function normalizeWorkspaceRelativePath(input: string): string | null {
  if (!input || hasControlCharacter(input)) return null
  if (input.startsWith('/') || input.startsWith('\\')) return null // absolute + UNC
  if (DRIVE_LETTER_RE.test(input)) return null
  // A leading `-` would be read as a flag by git even inside `--` in some
  // pathspec positions; there is no legitimate repo path that needs it.
  if (input.startsWith('-')) return null

  // Split on a SINGLE separator, not a run of them: collapsing `//` here would
  // silently normalize away an empty segment instead of rejecting it.
  const segments = input.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (EXCLUDED_WORKSPACE_DIR_NAMES.has(segment)) return null
  }
  return segments.join('/')
}

/**
 * Lexical check + real-path containment under `root`, resolving symlinks.
 *
 * Returns the normalized POSIX-relative path (what git wants as a pathspec),
 * never the absolute one — callers pass the relative form to git with `cwd`
 * pinned to `root`, so an absolute path never appears in an argv array or in
 * anything echoed back to the client.
 *
 * A path that does not exist yet is still acceptable (git legitimately
 * operates on deleted files, and `restore` targets a path that may be absent
 * from the working tree): containment is then checked on the deepest ancestor
 * that DOES exist, which is sufficient because a symlink must exist to
 * redirect anything.
 */
export function resolveWorkspaceRelativePath(root: string, input: string): string | null {
  const relPath = normalizeWorkspaceRelativePath(input)
  if (relPath === null) return null

  const realRoot = safeRealpath(root)
  if (realRoot === null) return null

  const absolute = resolve(root, relPath)
  let current = absolute
  for (;;) {
    const real = safeRealpath(current)
    if (real !== null) {
      return real === realRoot || real.startsWith(realRoot + sep) ? relPath : null
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function safeRealpath(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(path) : null
  } catch {
    return null
  }
}

/**
 * Argv-safety for a branch name. Git's `check-ref-format` is the authority on
 * what a ref may be called and runs separately; this only rejects what would
 * be dangerous or nonsensical BEFORE that subprocess is reached — a name that
 * would be read as a flag, a control character, or an absurd length.
 */
export function isArgvSafeBranchName(name: string): boolean {
  if (!name || name.length > 255) return false
  if (hasControlCharacter(name)) return false
  if (name.startsWith('-')) return false
  return true
}

/** A raw object name as `git log` prints it — hex, 7–40 chars. Deliberately NOT git's wider revision grammar. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(value)
}

/**
 * A commit message is passed as a single `-m` argv token, so it cannot be
 * split into extra arguments — but an empty message produces a commit nobody
 * can read, and an unbounded one is a denial-of-service on every later `git
 * log` this panel renders. NUL is rejected because argv is NUL-terminated.
 */
export function isAcceptableCommitMessage(message: string): boolean {
  const trimmed = message.trim()
  return trimmed.length > 0 && trimmed.length <= 4096 && !trimmed.includes('\u0000')
}
