/**
 * `clientSafeGitError` — what git's own output is allowed to carry outward.
 *
 * It reaches two audiences, and the second is why this file exists: the Git
 * panel (the operator's own browser) and `studio_git_commit`'s `git-failed`
 * refusal, which hands the same string to a model — i.e. to whichever provider
 * that turn is talking to. Its contract is "no absolute paths", and `sec-12`
 * found the elision covered the workspace root only, while git routinely names
 * files one directory up (`~/.gitconfig`, `core.excludesFile`, a hooks path).
 */
import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { clientSafeGitError, type GitRunResult } from './gitRunner'
import { projectsRootDir } from '../studioProjects'

function failed(stderr: string): GitRunResult {
  return { ok: false, exitCode: 128, stdout: '', stderr, timedOut: false }
}

describe('clientSafeGitError', () => {
  it('elides the workspace root', () => {
    const path = join(resolve(projectsRootDir()), 'demo', 'src', 'Home.tsx')
    const out = clientSafeGitError(failed(`error: cannot stage '${path}'`), 'nope')
    expect(out).not.toContain(resolve(projectsRootDir()))
    expect(out).toContain('<workspace>')
  })

  it('elides the home directory — git names paths OUTSIDE the workspace too', () => {
    const config = join(homedir(), '.gitconfig')
    const out = clientSafeGitError(failed(`warning: unable to access '${config}': Permission denied`), 'nope')
    expect(out, 'the operator\'s home path reached the model').not.toContain(homedir())
    expect(out).toContain('<home>')
  })

  it('elides a forward-slashed home path, which is how git prints one on Windows', () => {
    // The two sides disagree on separators: `homedir()` answers `C:\Users\me`,
    // git prints `C:/Users/me/...`. Matching only the native form would leave
    // exactly the path this is meant to remove.
    const posixHome = homedir().replace(/\\/g, '/')
    const out = clientSafeGitError(failed(`warning: unable to access '${posixHome}/.gitconfig'`), 'nope')
    expect(out).not.toContain(posixHome)
    expect(out).toContain('<home>')
  })

  it('keeps the workspace label when the workspace sits inside the home directory', () => {
    // Elision order is load-bearing: elide home first and the workspace path
    // becomes `<home>/...`, losing the more specific label.
    const root = resolve(projectsRootDir())
    if (!root.startsWith(homedir())) return
    const out = clientSafeGitError(failed(`error: cannot stage '${join(root, 'demo', 'a.tsx')}'`), 'nope')
    expect(out).toContain('<workspace>')
    expect(out).not.toContain('<home>')
  })

  it('still passes git\'s identity failure through — it is the actionable part, and not a path', () => {
    const raw = "fatal: unable to auto-detect email address (got 'me@laptop.(none)')"
    expect(clientSafeGitError(failed(raw), 'nope')).toContain('auto-detect email address')
  })

  it('caps the output and answers the fallback for an empty one', () => {
    expect(clientSafeGitError(failed('x'.repeat(5000)), 'nope')).toHaveLength(2000)
    expect(clientSafeGitError(failed('   '), 'nope')).toBe('nope')
    expect(clientSafeGitError({ ...failed(''), timedOut: true }, 'Push failed')).toContain('did not finish in time')
  })
})
