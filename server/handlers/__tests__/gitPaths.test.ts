/**
 * gitPaths — the boundary that decides whether a caller-supplied string may
 * become part of a git argv or a path git operates on.
 *
 * These are the rejection tests. They are the security control for the whole
 * git feature: everything downstream (`gitOperations.ts`) trusts what comes
 * out of here, so a hole here is a hole in `commit`, `diff`, and `restore` at
 * once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isAcceptableCommitMessage,
  isArgvSafeBranchName,
  isCommitSha,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceRelativePath,
} from '../studio/gitPaths'

describe('normalizeWorkspaceRelativePath', () => {
  it('accepts an ordinary nested source path', () => {
    expect(normalizeWorkspaceRelativePath('src/screens/Checkout.tsx')).toBe('src/screens/Checkout.tsx')
  })

  it('normalizes backslashes to POSIX separators', () => {
    expect(normalizeWorkspaceRelativePath('src\\screens\\Checkout.tsx')).toBe('src/screens/Checkout.tsx')
  })

  it.each([
    ['an absolute POSIX path', '/etc/passwd'],
    ['a UNC path', '\\\\server\\share\\file.txt'],
    ['a Windows drive letter', 'C:/Windows/System32/config'],
    ['traversal with forward slashes', '../../../etc/passwd'],
    ['traversal with backslashes', '..\\..\\..\\etc\\passwd'],
    ['traversal in the middle', 'src/../../etc/passwd'],
    ['a bare parent segment', '..'],
    ['a current-dir segment', './src/App.tsx'],
    ['an empty segment', 'src//App.tsx'],
    ['an empty string', ''],
    ['a leading dash that git would read as a flag', '--upload-pack=touch /tmp/pwned'],
    ['an embedded newline', 'src/App.tsx\nrm -rf /'],
    ['an embedded NUL', 'src/App.tsx\u0000.png'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeWorkspaceRelativePath(input)).toBeNull()
  })

  it.each(['.git/config', '.studio/meta.json', 'node_modules/left-pad/index.js', 'dist/main.js', '.next/cache/x', '.turbo/y', 'src/node_modules/evil.js'])(
    'rejects the excluded path %s',
    (input) => {
      expect(normalizeWorkspaceRelativePath(input)).toBeNull()
    },
  )
})

describe('resolveWorkspaceRelativePath', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-paths-'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export const App = () => null\n')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns the normalized relative path for a real file inside the root', () => {
    expect(resolveWorkspaceRelativePath(root, 'src/App.tsx')).toBe('src/App.tsx')
  })

  it('accepts a path that does not exist yet (a deleted or restored file)', () => {
    expect(resolveWorkspaceRelativePath(root, 'src/NotYet.tsx')).toBe('src/NotYet.tsx')
  })

  it('rejects a symlink that escapes the root, even though the path is lexically clean', () => {
    // The hole a textual containment check misses. A repository arriving from
    // GitHub carries git-stored symlinks, so this is a real shape, not a
    // hypothetical one.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-paths-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'innocent.txt'))
      expect(resolveWorkspaceRelativePath(root, 'src/innocent.txt')).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a path whose PARENT directory is a symlink out of the root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-paths-outside-dir-'))
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
      // The leaf does not exist, so containment falls back to the deepest
      // existing ancestor — which is the symlink, and it resolves outside.
      expect(resolveWorkspaceRelativePath(root, 'escape/anything.txt')).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects traversal before it ever reaches the filesystem', () => {
    expect(resolveWorkspaceRelativePath(root, '../../../etc/passwd')).toBeNull()
  })
})

describe('isArgvSafeBranchName', () => {
  it.each(['main', 'feat/checkout-polish', 'release-2026.09'])('accepts %s', (name) => {
    expect(isArgvSafeBranchName(name)).toBe(true)
  })

  it.each([
    ['an empty name', ''],
    ['a name that would be read as a flag', '--exec=rm -rf /'],
    ['a single-dash flag', '-D'],
    ['an embedded newline', 'main\nrm -rf /'],
    ['an embedded NUL', 'main\u0000'],
  ])('rejects %s', (_label, name) => {
    expect(isArgvSafeBranchName(name)).toBe(false)
  })

  it('rejects an absurdly long name', () => {
    expect(isArgvSafeBranchName('a'.repeat(256))).toBe(false)
  })
})

describe('isCommitSha', () => {
  it('accepts a short and a full hash', () => {
    expect(isCommitSha('5916129')).toBe(true)
    expect(isCommitSha('59161296b221d6c9376bc773d70f44425bb696b5')).toBe(true)
  })

  it.each([
    ['a revision expression', 'HEAD~3'],
    ['a reflog expression', '@{-1}'],
    ['a message search', ':/fix'],
    ['a branch name', 'main'],
    ['uppercase hex', '5916129ABCDEF'],
    ['too short', '591612'],
    ['too long', 'a'.repeat(41)],
  ])('rejects %s', (_label, value) => {
    expect(isCommitSha(value)).toBe(false)
  })
})

describe('isAcceptableCommitMessage', () => {
  it('accepts an ordinary message', () => {
    expect(isAcceptableCommitMessage('Tighten the checkout spacing')).toBe(true)
  })

  it('rejects an empty or whitespace-only message', () => {
    expect(isAcceptableCommitMessage('')).toBe(false)
    expect(isAcceptableCommitMessage('   \n  ')).toBe(false)
  })

  it('rejects a message past the cap', () => {
    expect(isAcceptableCommitMessage('x'.repeat(4097))).toBe(false)
  })
})
