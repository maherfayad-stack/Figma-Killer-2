/**
 * gitPaths — every string a client hands the git routes, judged before it can
 * reach an argv array; and, in one direction-reversed case
 * ({@link redactRemoteUrlCredentials}), a string git already holds, judged
 * before it can reach the client.
 *
 * Four separate untrusted shapes reach `git`, and each has its own way of
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
 *   - a **remote URL** (G1's `POST git/remote`, and the clone target). The
 *     dangerous one: git's URL grammar includes transports that EXECUTE
 *     (`ext::sh -c …`) and transports that point at this server's own disk
 *     (`file://`, a bare path). `parseGithubRemoteUrl` is an allowlist of two
 *     GitHub shapes and re-composes the URL from the parsed owner/repo, so the
 *     caller's string never reaches argv — see its own doc below.
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
 * A remote URL — the FOURTH untrusted shape (G1), and the one with the widest
 * blast radius: `git remote add` and `git clone` take a *transport*, not just
 * an address, and several of git's transports execute something.
 * `ext::sh -c …` runs a shell command. `file://` and a bare local path make a
 * "remote" out of any directory on this server, Studio's own repository
 * included. `ssh://user@host:port/…` reaches wherever the host's keys reach.
 *
 * So `parseGithubRemoteUrl` is an allowlist of exactly two shapes, and nothing
 * else is a remote in v1:
 *
 *   `https://github.com/<owner>/<repo>`   (`.git` and a trailing `/` tolerated)
 *   `git@github.com:<owner>/<repo>.git`
 *
 * `<owner>` and `<repo>` are judged by `isGithubOwnerSegment` /
 * `isGithubRepoSegment`, not by a bare charset test. The charset
 * (`[A-Za-z0-9_.-]`) excludes `/`, `:`, `@`, whitespace, and every control
 * character, so a parsed pair can never re-compose into a different transport
 * — but it does NOT exclude `.` or `..`, which are path instructions rather
 * than names. Those two functions do. No userinfo is accepted in the HTTPS
 * form either: a URL carrying `user:password@` would persist a credential in
 * plaintext into the project's `.git/config`, which is the exact thing G2
 * exists to avoid.
 */
const GITHUB_REMOTE_HOSTS = new Set(['github.com', 'www.github.com'])
const GITHUB_SSH_REMOTE_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/

/** GitHub's own ceilings: 39 characters for a user or organisation, 100 for a repository. */
const GITHUB_OWNER_MAX_LENGTH = 39
const GITHUB_REPO_MAX_LENGTH = 100

const SAFE_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/
/** `.`, `..`, `...` — a segment made of nothing but dots. Never a repository; always a path instruction. */
const DOTS_ONLY_SEGMENT = /^\.+$/

/**
 * Is this a GitHub-legal owner (user or organisation) segment?
 *
 * The charset alone was not enough, and this is not hypothetical: `sec-13`
 * found that the SSH form accepted `git@github.com:../hello-world.git`,
 * because `..` matches `[A-Za-z0-9_.-]+` and the HTTPS branch's protection
 * against it was an accident of `new URL` normalising the pathname, not a
 * rule anyone had written down. A `..` owner reshapes every string the pair is
 * later composed into — the `api.github.com/repos/<owner>/<repo>` URL
 * `githubPullRequest.ts` builds, and the `<owner>-<repo>` project folder name
 * `githubProjectFolderName` derives.
 *
 * So: no dots-only segment, no leading or trailing `-` (which GitHub itself
 * rejects, and which would make the derived folder name argv-flag-shaped), and
 * GitHub's own length ceiling.
 */
export function isGithubOwnerSegment(value: string): boolean {
  if (!value || value.length > GITHUB_OWNER_MAX_LENGTH) return false
  if (!SAFE_REPO_SEGMENT.test(value)) return false
  if (DOTS_ONLY_SEGMENT.test(value)) return false
  if (value.startsWith('-') || value.endsWith('-')) return false
  return true
}

/**
 * Is this a GitHub-legal repository segment? Same reasoning as
 * {@link isGithubOwnerSegment}, with the repository charset's genuine extra
 * latitude preserved: a leading dot is legal (`.github` is GitHub's own
 * convention for an organisation profile repository), so only a segment made
 * ENTIRELY of dots is refused.
 */
export function isGithubRepoSegment(value: string): boolean {
  if (!value || value.length > GITHUB_REPO_MAX_LENGTH) return false
  if (!SAFE_REPO_SEGMENT.test(value)) return false
  if (DOTS_ONLY_SEGMENT.test(value)) return false
  if (value.startsWith('-')) return false
  return true
}

export interface GithubRemote {
  owner: string
  repo: string
  /** The URL normalized to its canonical form — what is handed to git, never the caller's string. */
  url: string
  protocol: 'https' | 'ssh'
}

/**
 * Parses a caller-supplied remote URL, or returns `null` for anything outside
 * the two accepted shapes (see the block above for why the allowlist is that
 * narrow). The returned `url` is RE-COMPOSED from the parsed owner/repo rather
 * than passed through, so nothing the caller wrote reaches an argv array
 * intact.
 */
export function parseGithubRemoteUrl(input: string): GithubRemote | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 512 || hasControlCharacter(trimmed)) return null

  const ssh = GITHUB_SSH_REMOTE_RE.exec(trimmed)
  if (ssh) {
    const owner = ssh[1]
    const repo = ssh[2].replace(/\.git$/i, '')
    if (!isGithubOwnerSegment(owner) || !isGithubRepoSegment(repo)) return null
    return { owner, repo, url: `git@github.com:${owner}/${repo}.git`, protocol: 'ssh' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  // `https` only. Not `http` (a remote URL is persisted and reused, so the
  // downgrade would be permanent), and emphatically not `ext`, `file`, `ssh`,
  // or `git`.
  if (parsed.protocol !== 'https:') return null
  if (!GITHUB_REMOTE_HOSTS.has(parsed.hostname.toLowerCase())) return null
  if (parsed.username || parsed.password) return null
  if (parsed.search || parsed.hash) return null

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 2) return null
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, '')
  if (!isGithubOwnerSegment(owner) || !isGithubRepoSegment(repo)) return null

  return { owner, repo, url: `https://github.com/${owner}/${repo}.git`, protocol: 'https' }
}

/**
 * The one directory name a cloned repository may land in:
 * `studio-workspace/<owner>-<repo>`, matching the zipball import's
 * `defaultGithubImportDir` so the same repo gets the same project name however
 * it arrived. Derived from the PARSED owner/repo, never from a caller-supplied
 * directory — see `gitClone.ts`.
 */
export function githubProjectFolderName(remote: GithubRemote): string {
  return `${remote.owner}-${remote.repo}`
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

/**
 * Strips the credential out of a remote URL before it can leave the server.
 *
 * `GET /admin/api/studio/git/remotes` is a `site.read` route — the capability
 * the **Client** role holds — and `git remote -v` prints whatever is in
 * `.git/config` verbatim. Studio's own `setOriginRemote` re-composes through
 * `parseGithubRemoteUrl` and never writes a credential into a remote, but a
 * repository cloned OUTSIDE Studio routinely carries one:
 * `https://x-access-token:<token>@github.com/o/r` is what a GitHub Actions
 * checkout leaves behind, and `https://<pat>@github.com/o/r` is what a
 * `git clone` with a pasted token leaves behind. Reported by `sec-16` as the
 * one place a stored credential could surface at `site.read`; closed here.
 *
 * Two rules, and the difference between them is not cosmetic:
 *
 *   - **http/https — the whole userinfo goes.** There is no such thing as a
 *     non-secret username in an HTTP git remote: a token with no password
 *     half (`https://ghp_…@github.com/o/r`) is the single most common shape,
 *     so keeping "just the username" would keep exactly the secret.
 *   - **every other scheme — only the password goes.** `ssh://git@github.com/
 *     o/r`'s `git` is the SSH *account*, carries nothing secret, and removing
 *     it would make the panel disagree with the user's terminal, which is the
 *     failure mode `excludedCount` exists to avoid elsewhere in this module.
 *
 * The scp-like form (`git@github.com:o/r.git`) has no `scheme://` and
 * therefore no userinfo syntax at all — returned untouched.
 *
 * Done textually rather than with `new URL`, which normalises, re-encodes and
 * can round-trip a URL git accepts into one it does not.
 */
export function redactRemoteUrlCredentials(url: string): string {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)/.exec(url)?.[1]
  if (!scheme) return url

  const rest = url.slice(scheme.length)
  const authorityEnd = rest.search(/[/?#]/)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd)

  // Last `@`, not first: userinfo may not legally contain one, and splitting
  // on the last is what every URL parser does with a malformed authority.
  const at = authority.lastIndexOf('@')
  if (at === -1) return url
  const userinfo = authority.slice(0, at)
  const host = authority.slice(at + 1)

  const lower = scheme.toLowerCase()
  if (lower === 'http://' || lower === 'https://') return `${scheme}${host}${tail}`

  const colon = userinfo.indexOf(':')
  if (colon === -1) return url
  return `${scheme}${userinfo.slice(0, colon)}@${host}${tail}`
}
