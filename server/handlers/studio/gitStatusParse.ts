/**
 * gitStatusParse — `git status --porcelain=v2 --branch -z` into a typed shape,
 * server-side. Pure: no filesystem, no subprocess, no `dir`. Every branch of
 * this parser is exercised by `gitStatusParse.test.ts` against real captured
 * git output.
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
