/**
 * gitStatusParse — the porcelain-v2 parser, against output captured verbatim
 * from a real `git status --porcelain=v2 --branch -z` (git 2.50.1).
 *
 * Pure unit tests: no repository, no subprocess. The fixtures below are the
 * exact bytes git produced for a repo with a staged add, a staged rename with
 * an unstaged edit on top, an untracked file, a fresh repo before its first
 * commit, and a detached HEAD.
 */
import { describe, expect, it } from 'bun:test'
import { parseGitStatusPorcelainV2 } from '../studio/gitStatusParse'

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
