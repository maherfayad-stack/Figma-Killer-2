/**
 * gitOutputParse — git's stdout, turned into typed structures. Pure: no
 * filesystem, no subprocess, no `dir`. Every branch of every parser here is
 * exercised by `gitOutputParse.test.ts` against real captured git output.
 *
 * Four commands are read here, and they are read here rather than inline in
 * `gitOperations.ts`/`gitSyncOperations.ts` for one reason: **a parser that
 * takes a `string` can be driven with a transcript.** `runGit` spawns the
 * real `git`, and the real `git` on this machine will not print the output a
 * regression needs (a CRLF stream, a detached HEAD, a `gone` upstream) on
 * demand. Splitting the parse out is what makes those cases testable at all.
 *
 *   - `status --porcelain=v2 --branch -z` → {@link parseGitStatusPorcelainV2}
 *   - `remote -v`                         → {@link parseGitRemoteLines}
 *   - `log --format=…`                    → {@link parseGitLogRecords}
 *   - `for-each-ref --format=…`           → {@link parseGitBranchRefs}
 *
 * ## Line endings
 *
 * Every line-wise read here goes through `splitLines`/`toLf`. git itself
 * prints LF, but a `core.autocrlf` filter, a pager, or a wrapper on the user's
 * `PATH` can turn that into CRLF, and the `\r` then lands on whatever the LAST
 * field of a line happens to be — `%(HEAD)`, a commit sha, a remote's kind.
 * Gated by `src/__tests__/architecture/subprocess-output-line-endings.test.ts`.
 *
 * ## Why v2, and why `-z`
 *
 * Porcelain v1 (`XY path`) is ambiguous in exactly the cases a design tool
 * hits: it cannot distinguish a rename's two paths without heuristics, and it
 * gives no branch divergence. v2 is explicitly documented as machine-readable
 * and stable, and `--branch` adds the header lines the panel needs to say
 * "2 ahead, 1 behind".
 *
 * `-z` (NUL-terminated records, paths verbatim) rather than the default
 * newline form, because a path may legally contain a space, a quote, or a
 * newline. In the default form git C-quotes such paths and the parser has to
 * unquote them; with `-z` there is nothing to unquote and nothing to get
 * wrong. The one wrinkle is that a rename entry (type `2`) then spans TWO
 * NUL-terminated fields — the new path, then the original — which is why this
 * is an index-walking loop rather than a `map` over split records.
 *
 * ## The shape it produces
 *
 * git's `XY` field carries two independent statuses: `X` is what the INDEX
 * says versus HEAD (staged), `Y` is what the WORKING TREE says versus the
 * index (unstaged). A file can be both at once — staged an edit, then edited
 * again — and the panel must be able to say so, so `staged` and `unstaged`
 * are separate fields on one entry per path rather than two entries.
 *
 * Untracked (`?`) and unmerged (`u`) records get their own `kind`, because
 * they mean different things to the UI: an untracked file has no diff against
 * the index (it diffs against `/dev/null` — see `gitOperations.ts`), and an
 * unmerged file must not be offered as a one-click commit.
 *
 * Ignored (`!`) records are never requested (`--porcelain=v2` does not list
 * them without `--ignored`) and are skipped defensively if they ever appear.
 */

import { splitLines, toLf } from '@core/utils/lineEndings'

/** What the index says about a path, relative to HEAD. `null` when the index matches HEAD. */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed'

export interface GitStatusEntry {
  /** Workspace-root-relative, POSIX-separated — exactly what git printed, which is already relative to the repository root. */
  path: string
  /** For a rename/copy, the path the content came FROM. `null` otherwise. */
  originalPath: string | null
  /** Index-vs-HEAD change, or `null` when nothing is staged for this path. */
  staged: GitChangeKind | null
  /** Working-tree-vs-index change, or `null` when the working tree matches the index. */
  unstaged: GitChangeKind | null
  /** `true` for a `?` record — a file git has never tracked. It has no index state, so `staged`/`unstaged` are both `null`. */
  untracked: boolean
  /** `true` for a `u` record — a merge conflict. Never offered as a one-click commit. */
  unmerged: boolean
}

export interface GitBranchStatus {
  /** Current branch name, `null` on a detached HEAD, `null` on a repository with no commits yet (git reports `(initial)`). */
  branch: string | null
  /** `true` when HEAD is detached — the panel refuses to commit in that state rather than creating an unreachable commit. */
  detached: boolean
  /** Configured upstream (e.g. `origin/main`), or `null` when the branch has none — which is what makes a push a `--set-upstream` push. */
  upstream: string | null
  /** Commits on this branch not on its upstream. `null` when there is no upstream to compare against. */
  ahead: number | null
  /** Commits on the upstream not on this branch. `null` when there is no upstream. */
  behind: number | null
  /** `true` before the first commit — `git status` reports `# branch.oid (initial)`. Commit is still legal; log and diff-against-HEAD are not. */
  initial: boolean
}

export interface GitStatus {
  branchStatus: GitBranchStatus
  entries: GitStatusEntry[]
}

/** git's single-character status codes, in the order the v2 format documents them. */
const CHANGE_KIND_BY_CODE: Readonly<Record<string, GitChangeKind>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
}

/** `.` means "unchanged in this half of XY". Anything unrecognized is treated as unchanged rather than invented. */
function changeKind(code: string | undefined): GitChangeKind | null {
  if (!code || code === '.') return null
  return CHANGE_KIND_BY_CODE[code] ?? null
}

/**
 * Parses the raw stdout of `git status --porcelain=v2 --branch -z`.
 *
 * Unknown record types are skipped rather than throwing: git may add new ones,
 * and a status panel that renders nothing at all because of one unrecognized
 * line is worse than one that renders everything it understood.
 */
export function parseGitStatusPorcelainV2(stdout: string): GitStatus {
  const branchStatus: GitBranchStatus = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    initial: false,
  }
  const entries: GitStatusEntry[] = []

  // `-z` terminates every record with NUL, so the final split element is the
  // empty tail after the last terminator.
  const records = stdout.split('\u0000')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record) continue

    if (record.startsWith('# ')) {
      applyBranchHeader(branchStatus, record.slice(2))
      continue
    }

    const type = record[0]
    if (type === '1') {
      const entry = parseOrdinaryEntry(record)
      if (entry) entries.push(entry)
      continue
    }
    if (type === '2') {
      // A rename/copy spans two fields: this record, then the original path.
      const originalPath = records[i + 1] ?? ''
      i += 1
      const entry = parseRenameEntry(record, originalPath)
      if (entry) entries.push(entry)
      continue
    }
    if (type === 'u') {
      const path = fieldsAfter(record, 10)
      if (path) {
        entries.push({ path, originalPath: null, staged: null, unstaged: null, untracked: false, unmerged: true })
      }
      continue
    }
    if (type === '?') {
      const path = record.slice(2)
      if (path) {
        entries.push({ path, originalPath: null, staged: null, unstaged: null, untracked: true, unmerged: false })
      }
      continue
    }
    // '!' (ignored, only with --ignored) and any future record type: skipped.
  }

  return { branchStatus, entries }
}

function applyBranchHeader(branchStatus: GitBranchStatus, header: string): void {
  const spaceIndex = header.indexOf(' ')
  const key = spaceIndex === -1 ? header : header.slice(0, spaceIndex)
  const value = spaceIndex === -1 ? '' : header.slice(spaceIndex + 1)

  if (key === 'branch.oid') {
    // `(initial)` is git's own spelling for "no commits yet".
    branchStatus.initial = value === '(initial)'
    return
  }
  if (key === 'branch.head') {
    if (value === '(detached)') {
      branchStatus.detached = true
      branchStatus.branch = null
    } else {
      branchStatus.branch = value
    }
    return
  }
  if (key === 'branch.upstream') {
    branchStatus.upstream = value || null
    return
  }
  if (key === 'branch.ab') {
    // `+<ahead> -<behind>`, always both, always signed.
    const match = /^\+(\d+)\s+-(\d+)$/.exec(value)
    if (match) {
      branchStatus.ahead = Number(match[1])
      branchStatus.behind = Number(match[2])
    }
  }
}

/** `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` */
function parseOrdinaryEntry(record: string): GitStatusEntry | null {
  const xy = record.slice(2, 4)
  const path = fieldsAfter(record, 8)
  if (!path) return null
  return {
    path,
    originalPath: null,
    staged: changeKind(xy[0]),
    unstaged: changeKind(xy[1]),
    untracked: false,
    unmerged: false,
  }
}

/** `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` — the original path arrives as the NEXT NUL-terminated field. */
function parseRenameEntry(record: string, originalPath: string): GitStatusEntry | null {
  const xy = record.slice(2, 4)
  const path = fieldsAfter(record, 9)
  if (!path) return null
  return {
    path,
    originalPath: originalPath || null,
    staged: changeKind(xy[0]),
    unstaged: changeKind(xy[1]),
    untracked: false,
    unmerged: false,
  }
}

/**
 * Returns everything after the first `count` space-separated fields, verbatim.
 *
 * The path is the LAST field of a v2 record and — under `-z` — may itself
 * contain spaces, so it can only be extracted by counting the fixed fields
 * that precede it, never by splitting the whole record on whitespace.
 */
function fieldsAfter(record: string, count: number): string {
  let index = 0
  for (let field = 0; field < count; field += 1) {
    const next = record.indexOf(' ', index)
    if (next === -1) return ''
    index = next + 1
  }
  return record.slice(index)
}

// ---------------------------------------------------------------------------
// `git remote -v`
// ---------------------------------------------------------------------------

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

/**
 * `git remote -v`'s two lines per remote (`<name>\t<url> (fetch)` and the
 * `(push)` twin) folded into one record per name.
 *
 * Unfiltered: a project that already had three remotes when the user opened it
 * should SEE three, even though Studio will only ever write `origin`.
 */
export function parseGitRemoteLines(stdout: string): GitRemote[] {
  const byName = new Map<string, GitRemote>()
  for (const line of splitLines(stdout)) {
    // `<name>\t<url> (fetch|push)` — tab-separated by git's own porcelain.
    const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const [, name, url, kind] = match
    const existing = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') existing.fetchUrl = url
    else existing.pushUrl = url
    byName.set(name, existing)
  }
  return [...byName.values()]
}

// ---------------------------------------------------------------------------
// `git log --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e`
// ---------------------------------------------------------------------------

/** ASCII unit/record separators — chosen for `git log --format` because neither can occur in a commit subject, author name, or ISO date. */
const FIELD_SEP = ''
const RECORD_SEP = ''

/** The `--format` string {@link parseGitLogRecords} reads. Defined beside the parser so the two can never drift apart. */
export const GIT_LOG_FORMAT = ['%H', '%h', '%an', '%aI', '%s'].join('%x1f') + '%x1e'

export interface GitLogEntry {
  sha: string
  shortSha: string
  author: string
  /** ISO-8601 with offset (`%aI`) — the client formats it; the server never guesses a locale. */
  date: string
  subject: string
}

/**
 * One entry per `%x1e`-terminated record, in the order `git log` printed them.
 *
 * `toLf` FIRST, and this is the whole reason this parser has a test: `git log`
 * writes its own newline AFTER the record separator, so every record but the
 * first begins with that newline and has it stripped below. On a CRLF stream
 * the leading break is `\r\n`, `/^\n/` misses it, and the surviving `\r` lands
 * at the front of `%H` — every commit but the first gets a 41-character sha
 * that matches nothing the panel can act on.
 */
export function parseGitLogRecords(stdout: string): GitLogEntry[] {
  return toLf(stdout)
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [sha, shortSha, author, date, subject] = record.split(FIELD_SEP)
      if (!sha || !shortSha) return []
      return [{ sha, shortSha, author: author ?? '', date: date ?? '', subject: subject ?? '' }]
    })
}

// ---------------------------------------------------------------------------
// `git for-each-ref --format=…`
// ---------------------------------------------------------------------------

export interface GitBranchSummary {
  /** Short name — `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: string
  /** `true` for a `refs/remotes/…` ref. The panel offers these as "check out a copy of", never as a thing to commit onto. */
  remote: boolean
  /** The one branch HEAD points at. Always exactly one, or none on a detached HEAD. */
  current: boolean
  /** Configured upstream (`origin/main`), or `null`. Always `null` for a remote-tracking ref. */
  upstream: string | null
  /** Commits on this branch not on its upstream. `null` when there is no upstream to compare against. */
  ahead: number | null
  behind: number | null
  /** The upstream is configured but no longer exists on the remote — git's own `gone`. */
  upstreamGone: boolean
}

/** The `--format` string {@link parseGitBranchRefs} reads. `%1f` is a raw byte, and no ref name may contain a control character. */
export const GIT_BRANCH_REF_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
].join('%1f')

const REF_FIELD_SEP = ''

/** `ahead 2, behind 1` / `ahead 3` / `behind 4` / `gone` / empty — git's `%(upstream:track,nobracket)`. */
function parseUpstreamTrack(track: string): { ahead: number | null; behind: number | null; gone: boolean } {
  if (track === 'gone') return { ahead: null, behind: null, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  if (!ahead && !behind) return { ahead: null, behind: null, gone: false }
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false }
}

/**
 * Every ref {@link GIT_BRANCH_REF_FORMAT} printed, plus which one is checked
 * out. `current` is `null` on a detached HEAD, which is a normal answer.
 *
 * `splitLines`, not a bare `'\n'` split: `%(HEAD)` is the LAST field of the
 * format, so a trailing `\r` makes `head === '*'` false for every branch and
 * the panel reports no current branch at all.
 */
export function parseGitBranchRefs(stdout: string): { branches: GitBranchSummary[]; current: string | null } {
  const branches: GitBranchSummary[] = []
  let current: string | null = null
  for (const line of splitLines(stdout)) {
    if (!line.trim()) continue
    const [refname, short, upstream, track, head] = line.split(REF_FIELD_SEP)
    if (!refname || !short) continue
    // `origin/HEAD` is a symbolic ref to another entry in this same list, not
    // a branch anyone can check out. It is read separately by its caller.
    if (refname.endsWith('/HEAD')) continue
    const remote = refname.startsWith('refs/remotes/')
    const isCurrent = head === '*'
    if (isCurrent) current = short
    const { ahead, behind, gone } = parseUpstreamTrack((track ?? '').trim())
    branches.push({
      name: short,
      remote,
      current: isCurrent,
      upstream: remote ? null : upstream || null,
      ahead,
      behind,
      upstreamGone: gone,
    })
  }
  return { branches, current }
}
