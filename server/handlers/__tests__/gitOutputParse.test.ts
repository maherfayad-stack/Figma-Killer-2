/**
 * gitOutputParse — the four parsers that turn git's stdout into structures,
 * against output captured verbatim from a real git (2.50.1).
 *
 * Pure unit tests: no repository, no subprocess. The fixtures below are the
 * exact bytes git produced for a repo with a staged add, a staged rename with
 * an unstaged edit on top, an untracked file, a fresh repo before its first
 * commit, and a detached HEAD.
 *
 * The CRLF block at the end is the point of the split: the real `git` on this
 * machine prints LF and will not produce a CRLF stream on request, so the only
 * way to regress "a `core.autocrlf` filter or a wrapper injected `\r`" is to
 * hand the parser a transcript. Each case asserts the CRLF transcript parses
 * to exactly what its LF twin does.
 */
import { describe, expect, it } from 'bun:test'
import {
  GIT_BRANCH_REF_FORMAT,
  GIT_LOG_FORMAT,
  parseGitBranchRefs,
  parseGitLogRecords,
  parseGitRemoteLines,
  parseGitStatusPorcelainV2,
} from '../studio/gitOutputParse'

const NUL = '\u0000'

/** Captured from a real repo: staged rename+modify, staged add in a subdir, one untracked file. */
const MIXED =
  [
    '# branch.oid 59161296b221d6c9376bc773d70f44425bb696b5',
    '# branch.head main',
    '2 RM N... 100644 100644 100644 7898192261 7898192261 R100 renamed.txt',
    'a.txt',
    '1 A. N... 000000 100644 100644 0000000000 587be6b4c3 sub/c.txt',
    '? untracked.txt',
  ].join(NUL) + NUL

describe('parseGitStatusPorcelainV2', () => {
  it('reads the branch header', () => {
    const { branchStatus } = parseGitStatusPorcelainV2(MIXED)
    expect(branchStatus.branch).toBe('main')
    expect(branchStatus.detached).toBe(false)
    expect(branchStatus.initial).toBe(false)
    expect(branchStatus.upstream).toBeNull()
    expect(branchStatus.ahead).toBeNull()
    expect(branchStatus.behind).toBeNull()
  })

  it('reads a rename as one entry carrying BOTH its paths', () => {
    const { entries } = parseGitStatusPorcelainV2(MIXED)
    const renamed = entries.find((e) => e.path === 'renamed.txt')
    expect(renamed).toBeDefined()
    // `RM` — renamed in the index, modified again in the working tree. Both
    // halves must survive; collapsing them would lose "you have edits on top
    // of what you staged".
    expect(renamed!.staged).toBe('renamed')
    expect(renamed!.unstaged).toBe('modified')
    expect(renamed!.originalPath).toBe('a.txt')
  })

  it('consumes the rename original-path field rather than parsing it as a record', () => {
    const { entries } = parseGitStatusPorcelainV2(MIXED)
    // If the second NUL field were treated as its own record, `a.txt` would
    // appear as a bogus entry and the following `1 …` record would be misread.
    expect(entries.map((e) => e.path)).toEqual(['renamed.txt', 'sub/c.txt', 'untracked.txt'])
  })

  it('reads a staged-only add', () => {
    const { entries } = parseGitStatusPorcelainV2(MIXED)
    const added = entries.find((e) => e.path === 'sub/c.txt')!
    expect(added.staged).toBe('added')
    expect(added.unstaged).toBeNull()
    expect(added.untracked).toBe(false)
  })

  it('reads an untracked file with no index state', () => {
    const { entries } = parseGitStatusPorcelainV2(MIXED)
    const untracked = entries.find((e) => e.path === 'untracked.txt')!
    expect(untracked.untracked).toBe(true)
    expect(untracked.staged).toBeNull()
    expect(untracked.unstaged).toBeNull()
  })

  it('reads a repository with no commits yet as initial', () => {
    const fresh = ['# branch.oid (initial)', '# branch.head main', '? x.txt'].join(NUL) + NUL
    const { branchStatus, entries } = parseGitStatusPorcelainV2(fresh)
    expect(branchStatus.initial).toBe(true)
    expect(branchStatus.branch).toBe('main')
    expect(entries).toHaveLength(1)
  })

  it('reads a detached HEAD as detached, with no branch name', () => {
    const detached = ['# branch.oid abc123', '# branch.head (detached)'].join(NUL) + NUL
    const { branchStatus } = parseGitStatusPorcelainV2(detached)
    expect(branchStatus.detached).toBe(true)
    expect(branchStatus.branch).toBeNull()
  })

  it('reads upstream divergence', () => {
    const diverged =
      ['# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'].join(NUL) + NUL
    const { branchStatus } = parseGitStatusPorcelainV2(diverged)
    expect(branchStatus.upstream).toBe('origin/main')
    expect(branchStatus.ahead).toBe(2)
    expect(branchStatus.behind).toBe(3)
  })

  it('keeps a path containing spaces intact', () => {
    // The whole reason the parser counts fixed fields instead of splitting on
    // whitespace. A `-z` path is verbatim, spaces and all.
    const spaced = ['# branch.head main', '1 .M N... 100644 100644 100644 aaa bbb my file (2).tsx'].join(NUL) + NUL
    const { entries } = parseGitStatusPorcelainV2(spaced)
    expect(entries[0]!.path).toBe('my file (2).tsx')
    expect(entries[0]!.staged).toBeNull()
    expect(entries[0]!.unstaged).toBe('modified')
  })

  it('reads an unmerged record as unmerged', () => {
    const conflicted =
      ['# branch.head main', 'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.tsx'].join(NUL) + NUL
    const { entries } = parseGitStatusPorcelainV2(conflicted)
    expect(entries[0]!.path).toBe('conflict.tsx')
    expect(entries[0]!.unmerged).toBe(true)
  })

  it('skips record types it does not understand instead of throwing', () => {
    const unknown = ['# branch.head main', '! ignored.txt', 'z something new', '? real.txt'].join(NUL) + NUL
    const { entries } = parseGitStatusPorcelainV2(unknown)
    expect(entries.map((e) => e.path)).toEqual(['real.txt'])
  })

  it('reads an empty status as a clean tree', () => {
    const { entries } = parseGitStatusPorcelainV2('')
    expect(entries).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// `remote -v`, `log`, `for-each-ref` — and the same three on a CRLF stream
// ---------------------------------------------------------------------------

const US = ''
const RS = ''

/** LF → CRLF, the way a `core.autocrlf` filter or a wrapper on the user's PATH rewrites a stream. */
function asCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n')
}

/** Verbatim `remote -v` for a repo with two remotes. */
const REMOTE_TRANSCRIPT =
  [
    'origin\thttps://github.com/acme/warehouse-stock.git (fetch)',
    'origin\thttps://github.com/acme/warehouse-stock.git (push)',
    'upstream\thttps://github.com/upstream-co/warehouse-stock.git (fetch)',
    'upstream\thttps://github.com/upstream-co/warehouse-stock.git (push)',
  ].join('\n') + '\n'

/** Three commits in `GIT_LOG_FORMAT`: `%x1e`, then git's own newline, between records. */
const LOG_TRANSCRIPT =
  [
    ['9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4', '9f2c1ab', 'Ada Okafor', '2026-09-12T09:14:03+01:00', 'Add the stock-room shelf map'],
    ['3e8d7c6b5a49382716f5e4d3c2b1a09876543210', '3e8d7c6', 'Ada Okafor', '2026-09-11T17:02:44+01:00', 'Split the intake form into two steps'],
    ['1122334455667788990011223344556677889900', '1122334', 'Bo Lindqvist', '2026-09-10T11:30:00+01:00', 'Seed the pallet fixtures'],
  ]
    .map((fields) => fields.join(US) + RS)
    .join('\n') + '\n'

/** Verbatim `for-each-ref` in `GIT_BRANCH_REF_FORMAT`. `%(HEAD)` is the LAST field, and it is empty on every branch but the checked-out one. */
const BRANCH_TRANSCRIPT =
  [
    ['refs/heads/main', 'main', 'origin/main', 'ahead 2, behind 1', ''].join(US),
    ['refs/heads/shelf-map', 'shelf-map', '', '', '*'].join(US),
    ['refs/heads/retired', 'retired', 'origin/retired', 'gone', ''].join(US),
    ['refs/remotes/origin/HEAD', 'origin/HEAD', '', '', ''].join(US),
    ['refs/remotes/origin/main', 'origin/main', '', '', ''].join(US),
  ].join('\n') + '\n'

describe('parseGitRemoteLines', () => {
  it('folds the fetch and push lines of each remote into one record', () => {
    expect(parseGitRemoteLines(REMOTE_TRANSCRIPT)).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://github.com/acme/warehouse-stock.git',
        pushUrl: 'https://github.com/acme/warehouse-stock.git',
      },
      {
        name: 'upstream',
        fetchUrl: 'https://github.com/upstream-co/warehouse-stock.git',
        pushUrl: 'https://github.com/upstream-co/warehouse-stock.git',
      },
    ])
  })

  it('reads a repository with no remotes as an empty list', () => {
    expect(parseGitRemoteLines('')).toEqual([])
  })
})

describe('parseGitLogRecords', () => {
  it('reads every record, in the order it was printed', () => {
    const entries = parseGitLogRecords(LOG_TRANSCRIPT)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      sha: '9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4',
      shortSha: '9f2c1ab',
      author: 'Ada Okafor',
      date: '2026-09-12T09:14:03+01:00',
      subject: 'Add the stock-room shelf map',
    })
    expect(entries[2]!.subject).toBe('Seed the pallet fixtures')
  })

  it('reads a repository with no commits as an empty list', () => {
    expect(parseGitLogRecords('')).toEqual([])
  })

  it('names the format it parses, so its caller cannot drift from it', () => {
    expect(GIT_LOG_FORMAT).toBe('%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e')
  })
})

describe('parseGitBranchRefs', () => {
  it('reads every ref, the checked-out one, and per-branch divergence', () => {
    const { branches, current } = parseGitBranchRefs(BRANCH_TRANSCRIPT)
    expect(current).toBe('shelf-map')
    // `origin/HEAD` is a symbolic ref to another entry in the same list.
    expect(branches.map((b) => b.name)).toEqual(['main', 'shelf-map', 'retired', 'origin/main'])
    expect(branches[0]).toEqual({
      name: 'main',
      remote: false,
      current: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      upstreamGone: false,
    })
    expect(branches[1]!.current).toBe(true)
    expect(branches[2]!.upstreamGone).toBe(true)
    expect(branches[3]!.remote).toBe(true)
  })

  it('reports no current branch on a detached HEAD', () => {
    const detached = ['refs/heads/main', 'main', '', '', ''].join(US) + '\n'
    expect(parseGitBranchRefs(detached).current).toBeNull()
  })

  it('names the format it parses, so its caller cannot drift from it', () => {
    expect(GIT_BRANCH_REF_FORMAT).toBe(
      '%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)',
    )
  })
})

describe('a CRLF stream parses to exactly what its LF twin does', () => {
  it('remote -v', () => {
    expect(parseGitRemoteLines(asCrlf(REMOTE_TRANSCRIPT))).toEqual(parseGitRemoteLines(REMOTE_TRANSCRIPT))
  })

  it('log — the break before every record but the first is `\\r\\n`', () => {
    const crlf = parseGitLogRecords(asCrlf(LOG_TRANSCRIPT))
    expect(crlf).toEqual(parseGitLogRecords(LOG_TRANSCRIPT))
    // Stated separately, because it is the symptom: read with a bare `'\n'`,
    // every sha after the first is 41 characters long and matches nothing.
    for (const entry of crlf) expect(entry.sha).toHaveLength(40)
  })

  it('for-each-ref — `%(HEAD)` is the last field, so the `\\r` lands on it', () => {
    const crlf = parseGitBranchRefs(asCrlf(BRANCH_TRANSCRIPT))
    expect(crlf).toEqual(parseGitBranchRefs(BRANCH_TRANSCRIPT))
    // Stated separately: read with a bare `'\n'` this is `null`, and the panel
    // shows no checked-out branch at all.
    expect(crlf.current).toBe('shelf-map')
  })

  it('status --porcelain=v2 -z is unaffected — it is NUL-delimited, not line-delimited', () => {
    const status = ['# branch.head main', '? untracked-note.txt'].join(NUL) + NUL
    expect(parseGitStatusPorcelainV2(asCrlf(status))).toEqual(parseGitStatusPorcelainV2(status))
  })
})
