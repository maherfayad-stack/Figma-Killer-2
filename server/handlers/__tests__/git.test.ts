/**
 * git routes — end-to-end against REAL `git`, in a real project directory
 * created inside `projectsRootDir()` so the routes' own containment guard
 * passes (same fixture posture as `trustTier.test.ts`).
 *
 * Two halves, both load-bearing:
 *
 *   1. **The definition of done.** Edit a file, see it in status, read its
 *      diff, create a branch, commit exactly that file, push to a LOCAL BARE
 *      REMOTE created by the test — every step through the HTTP routes, not
 *      through the operation functions directly. If this passes, a designer
 *      can ship.
 *   2. **The rejections.** These are the security control, so they are tested
 *      harder than the happy path: a `dir` outside the workspace, a `dir` with
 *      no repository of its own (which without the guard would resolve to
 *      Studio's OWN repository), traversal and excluded paths in every
 *      path-taking route, a dirty-tree branch switch, an empty commit, a push
 *      with no remote, and a revision expression where a sha is required.
 *
 * `git` identity is set per-repository (`git config user.*`) rather than read
 * from the host, so the test does not depend on the developer's global config
 * and does not write to it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioGit } from '../studio/git'
import { ProjectDirOutsideWorkspaceError } from '../studioProjects'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  return { code: await proc.exited, out, err }
}

function request(pathAndQuery: string, init?: RequestInit) {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url, init), url, pathname: url.pathname }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function call(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const { req, url, pathname } = request(pathAndQuery, init)
  const res = await tryServeStudioGit(req, url, pathname)
  if (!res) throw new Error(`no route matched ${pathAndQuery}`)
  return res
}

/** Every temp path this file makes, cleaned up in `afterAll` even if a test throws mid-way. */
const created: string[] = []

function makeProjectDir(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, '__git_route_test_'))
  created.push(dir)
  return dir
}

async function makeRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main'])
  await git(dir, ['config', 'user.email', 'studio-test@example.com'])
  await git(dir, ['config', 'user.name', 'Studio Test'])
  // `commit.gpgsign` on the developer's machine would make every commit here
  // prompt for a key; the repo-local override keeps the test hermetic.
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return null }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'Initial commit'])
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The definition of done
// ---------------------------------------------------------------------------

describe('git routes — edit, review, branch, commit, push', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
  })

  it('carries one canvas edit all the way to a pushed commit on a new branch', async () => {
    // 1. A canvas edit — the shape every writeback produces: a changed .tsx.
    fs.writeFileSync(
      path.join(dir, 'pages', 'Home.tsx'),
      'export default function Home() { return <main>hello</main> }\n',
    )

    // 2. It shows up in status as an unstaged modification.
    const statusRes = await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(dir)}`)
    expect(statusRes.status).toBe(200)
    const status = (await statusRes.json()) as {
      isRepo: boolean
      status: { branch: { branch: string }; entries: Array<{ path: string; unstaged: string | null }>; hasOrigin: boolean }
    }
    expect(status.isRepo).toBe(true)
    expect(status.status.branch.branch).toBe('main')
    expect(status.status.hasOrigin).toBe(false)
    const entry = status.status.entries.find((e) => e.path === 'pages/Home.tsx')
    expect(entry?.unstaged).toBe('modified')

    // 3. Its diff is readable, and it is the real unified diff.
    const diffRes = await call(
      `/admin/api/studio/git/diff?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent('pages/Home.tsx')}`,
    )
    const diff = (await diffRes.json()) as { unstaged: string; staged: string; untracked: boolean }
    expect(diff.untracked).toBe(false)
    expect(diff.unstaged).toContain('+export default function Home() { return <main>hello</main> }')
    expect(diff.staged).toBe('')

    // 4. A new branch — allowed with a dirty tree, because creating a branch at
    //    HEAD cannot lose a byte of the user's work.
    const branchRes = await call('/admin/api/studio/git/branch', post({ dir, create: 'feat/hello' }))
    expect(branchRes.status).toBe(200)
    expect(await branchRes.json()).toMatchObject({ ok: true, branch: 'feat/hello', created: true })

    // 5. Commit exactly that file.
    const commitRes = await call(
      '/admin/api/studio/git/commit',
      post({ dir, message: 'Say hello on the home page', files: ['pages/Home.tsx'] }),
    )
    expect(commitRes.status).toBe(200)
    const commit = (await commitRes.json()) as { ok: boolean; sha: string; files: string[] }
    expect(commit.ok).toBe(true)
    expect(commit.files).toEqual(['pages/Home.tsx'])
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/)

    // 6. The tree is clean again, and the log shows the commit.
    const afterStatus = (await (await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(dir)}`)).json()) as {
      status: { entries: unknown[]; branch: { branch: string } }
    }
    expect(afterStatus.status.entries).toEqual([])
    expect(afterStatus.status.branch.branch).toBe('feat/hello')

    const log = (await (await call(`/admin/api/studio/git/log?dir=${encodeURIComponent(dir)}&limit=5`)).json()) as {
      commits: Array<{ subject: string; sha: string; author: string }>
    }
    expect(log.commits[0]!.subject).toBe('Say hello on the home page')
    expect(log.commits[0]!.author).toBe('Studio Test')

    // 7. Push to a LOCAL BARE REMOTE — a real push over git's own transport,
    //    with no network and no credentials.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-remote-'))
    created.push(remote)
    await git(remote, ['init', '--bare', '--initial-branch=main'])
    await git(dir, ['remote', 'add', 'origin', remote])

    const pushRes = await call('/admin/api/studio/git/push', post({ dir }))
    expect(pushRes.status).toBe(200)
    expect(await pushRes.json()).toMatchObject({ ok: true, branch: 'feat/hello' })

    // The remote genuinely has the branch and the commit.
    const remoteLog = await git(remote, ['log', '--format=%s', 'feat/hello'])
    expect(remoteLog.code).toBe(0)
    expect(remoteLog.out).toContain('Say hello on the home page')

    // And status now reports the upstream it just set.
    const pushedStatus = (await (await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(dir)}`)).json()) as {
      status: { branch: { upstream: string | null; ahead: number | null }; hasOrigin: boolean }
    }
    expect(pushedStatus.status.hasOrigin).toBe(true)
    expect(pushedStatus.status.branch.upstream).toBe('origin/feat/hello')
    expect(pushedStatus.status.branch.ahead).toBe(0)
  })

  it('diffs an untracked file against /dev/null', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'About.tsx'), 'export default function About() { return null }\n')
    const res = await call(
      `/admin/api/studio/git/diff?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent('pages/About.tsx')}`,
    )
    const diff = (await res.json()) as { untracked: boolean; unstaged: string }
    expect(diff.untracked).toBe(true)
    expect(diff.unstaged).toContain('new file mode')
    expect(diff.unstaged).toContain('+export default function About()')
  })

  it('restores one file from a commit', async () => {
    const head = (await git(dir, ['rev-parse', 'HEAD'])).out.trim()
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'RUINED\n')

    const res = await call('/admin/api/studio/git/restore', post({ dir, sha: head, file: 'pages/Home.tsx' }))
    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('export default function Home()')
  })

  it('initialises a repository, ignoring node_modules, behind an explicit confirm', async () => {
    const fresh = makeProjectDir()
    fs.mkdirSync(path.join(fresh, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(fresh, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(fresh, 'App.tsx'), 'export const App = () => null\n')

    // Before init, status is a normal answer that says "no repository yet".
    const before = (await (await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(fresh)}`)).json()) as {
      isRepo: boolean
      status: null
    }
    expect(before).toEqual({ isRepo: false, status: null })

    // A body without the literal `confirm: true` is refused by the schema.
    const unconfirmed = await call('/admin/api/studio/git/init', post({ dir: fresh }))
    expect(unconfirmed.status).toBe(400)

    const res = await call('/admin/api/studio/git/init', post({ dir: fresh, confirm: true }))

    // The repository and the scaffolded ignore file are what `init` itself
    // controls, and they must hold regardless of the host's git identity.
    expect(fs.existsSync(path.join(fresh, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(fresh, '.gitignore'), 'utf8')).toContain('node_modules')

    // The initial COMMIT needs a git identity, which is a host condition (a CI
    // box with no `user.email` is not a bug in this route). Assert the outcome
    // that matters in whichever case the host produced — never that
    // node_modules got committed.
    if (res.status === 200) {
      const body = (await res.json()) as { ok: boolean; filesCommitted: number }
      expect(body.ok).toBe(true)
      expect(body.filesCommitted).toBeGreaterThan(0)
      const tracked = (await git(fresh, ['ls-files'])).out
      expect(tracked).toContain('App.tsx')
      expect(tracked).not.toContain('node_modules')
    } else {
      expect(res.status).toBe(500)
    }

    // Re-running refuses rather than reinitialising.
    const again = await call('/admin/api/studio/git/init', post({ dir: fresh, confirm: true }))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'already-a-repository' })
  })
})

// ---------------------------------------------------------------------------
// The rejections — the actual security control
// ---------------------------------------------------------------------------

describe('git routes — rejections', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
  })

  it('returns null for a path this sub-router does not own', async () => {
    const { req, url, pathname } = request('/admin/api/studio/other')
    expect(await tryServeStudioGit(req, url, pathname)).toBeNull()
  })

  it('refuses every route for a dir outside studio-workspace/', async () => {
    await withOutsideWorkspaceDir('studio-git-outside', async (outside) => {
      await makeRepo(outside)
      const q = encodeURIComponent(outside)
      const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow(ProjectDirOutsideWorkspaceError)

      await refused(call(`/admin/api/studio/git/status?dir=${q}`))
      await refused(call(`/admin/api/studio/git/log?dir=${q}`))
      await refused(call(`/admin/api/studio/git/diff?dir=${q}&file=pages%2FHome.tsx`))
      await refused(call('/admin/api/studio/git/commit', post({ dir: outside, message: 'x', files: ['a.txt'] })))
      await refused(call('/admin/api/studio/git/push', post({ dir: outside })))
      await refused(call('/admin/api/studio/git/branch', post({ dir: outside, create: 'x' })))
      await refused(call('/admin/api/studio/git/init', post({ dir: outside, confirm: true })))
    })
  })

  it('never operates on Studio\'s own repository via a project that has no .git', async () => {
    // THE bug this guard exists for. `studio-workspace/` sits inside Studio's
    // own working tree, so git's discovery walk from a project with no `.git`
    // would find Studio's repository and report — or commit — that. Every
    // route except `status` and `init` must refuse.
    const bare = makeProjectDir()
    fs.writeFileSync(path.join(bare, 'App.tsx'), 'export const App = () => null\n')
    expect(fs.existsSync(path.join(bare, '.git'))).toBe(false)

    expect((await call(`/admin/api/studio/git/log?dir=${encodeURIComponent(bare)}`)).status).toBe(404)
    expect((await call(`/admin/api/studio/git/diff?dir=${encodeURIComponent(bare)}&file=App.tsx`)).status).toBe(404)
    expect((await call('/admin/api/studio/git/commit', post({ dir: bare, message: 'x', files: ['App.tsx'] }))).status).toBe(404)
    expect((await call('/admin/api/studio/git/push', post({ dir: bare }))).status).toBe(404)
    expect((await call('/admin/api/studio/git/branch', post({ dir: bare, create: 'x' }))).status).toBe(404)
    expect((await call('/admin/api/studio/git/restore', post({ dir: bare, sha: 'a'.repeat(40), file: 'App.tsx' }))).status).toBe(404)

    // `status` answers honestly instead — that is what makes the panel offer init.
    const status = await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(bare)}`)
    expect(await status.json()).toEqual({ isRepo: false, status: null })
  })

  it('404s the workspace root itself, which is inside Studio\'s own repository', async () => {
    const q = encodeURIComponent(projectsRootDir())
    expect((await call(`/admin/api/studio/git/status?dir=${q}`)).status).toBe(404)
    expect((await call('/admin/api/studio/git/init', post({ dir: projectsRootDir(), confirm: true }))).status).toBe(404)
  })

  it.each([
    ['traversal', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['an excluded directory', 'node_modules/left-pad/index.js'],
    ['Studio\'s own sidecar', '.studio/meta.json'],
    ['the git directory', '.git/config'],
    ['a flag-looking path', '--output=/tmp/pwned'],
  ])('404s a diff for %s', async (_label, file) => {
    const res = await call(
      `/admin/api/studio/git/diff?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`,
    )
    expect(res.status).toBe(404)
  })

  it('404s a commit if ANY requested path is unusable, committing nothing', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')
    const before = (await git(dir, ['rev-parse', 'HEAD'])).out.trim()

    const res = await call(
      '/admin/api/studio/git/commit',
      post({ dir, message: 'sneak', files: ['pages/Home.tsx', '../../../etc/passwd'] }),
    )
    expect(res.status).toBe(404)
    // Nothing was committed and nothing was staged — a partial commit here
    // would be worse than the refusal.
    expect((await git(dir, ['rev-parse', 'HEAD'])).out.trim()).toBe(before)
    expect((await git(dir, ['diff', '--cached', '--name-only'])).out.trim()).toBe('')
  })

  it('refuses a commit with an empty file list', async () => {
    const res = await call('/admin/api/studio/git/commit', post({ dir, message: 'nothing', files: [] }))
    expect(res.status).toBe(400)
  })

  it('refuses a commit with a blank message', async () => {
    const res = await call('/admin/api/studio/git/commit', post({ dir, message: '   ', files: ['pages/Home.tsx'] }))
    expect(res.status).toBe(400)
  })

  it('refuses switching branches over a dirty tree, and names the dirty files', async () => {
    await git(dir, ['branch', 'other'])
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'uncommitted work\n')

    const res = await call('/admin/api/studio/git/branch', post({ dir, switch: 'other' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; dirtyFiles: string[]; error: string }
    expect(body.code).toBe('dirty-tree')
    expect(body.dirtyFiles).toContain('pages/Home.tsx')
    // The work is still there and still on the original branch — no stash.
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toBe('uncommitted work\n')
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()).toBe('main')
  })

  it('switches branches when the tree is clean', async () => {
    await git(dir, ['branch', 'other'])
    const res = await call('/admin/api/studio/git/branch', post({ dir, switch: 'other' }))
    expect(res.status).toBe(200)
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()).toBe('other')
  })

  it.each([
    ['a flag', '--exec=touch /tmp/pwned'],
    ['a name git itself rejects', 'bad..name'],
    ['a name ending in .lock', 'feature.lock'],
    ['an embedded newline', 'main\nrm -rf /'],
  ])('refuses to create a branch named %s', async (_label, name) => {
    const res = await call('/admin/api/studio/git/branch', post({ dir, create: name }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'invalid-branch-name' })
  })

  it('refuses a branch request that names both create and switch', async () => {
    const res = await call('/admin/api/studio/git/branch', post({ dir, create: 'a', switch: 'b' }))
    expect(res.status).toBe(400)
  })

  it('refuses a push with no origin remote', async () => {
    const res = await call('/admin/api/studio/git/push', post({ dir }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'no-origin-remote' })
  })

  it.each([
    ['a revision expression', 'HEAD~1'],
    ['a reflog expression', '@{-1}'],
    ['a branch name', 'main'],
  ])('refuses a restore addressed by %s instead of a sha', async (_label, sha) => {
    const res = await call('/admin/api/studio/git/restore', post({ dir, sha, file: 'pages/Home.tsx' }))
    expect(res.status).toBe(400)
  })

  it('never puts a filesystem path in an error body', async () => {
    // A failing operation must not describe the server's layout. Restore of a
    // sha that does not exist is the easiest way to make git print a path.
    const res = await call('/admin/api/studio/git/restore', post({ dir, sha: 'f'.repeat(40), file: 'pages/Home.tsx' }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).not.toContain(projectsRootDir())
    expect(body.error).not.toContain(dir)
  })

  it('labels files the agent wrote this turn, and only those', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'agent wrote this\n')
    fs.writeFileSync(path.join(dir, 'pages', 'ByHand.tsx'), 'a human wrote this\n')
    // The log is per (project, account) since W10, and this marker is
    // deliberately read across EVERY account: "an agent wrote this file" is a
    // fact about the working tree, not about who is looking at it.
    const agentCache = path.join(dir, '.studio', 'cache', 'agent', 'a1b2c3d4e5f60718')
    fs.mkdirSync(agentCache, { recursive: true })
    fs.writeFileSync(
      path.join(agentCache, 'turnWrites.json'),
      JSON.stringify([{ file: 'pages/Home.tsx', atMs: Date.now() }]),
    )

    const status = (await (await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(dir)}`)).json()) as {
      status: { entries: Array<{ path: string; agentAuthored: boolean }> }
    }
    const byPath = new Map(status.status.entries.map((e) => [e.path, e.agentAuthored]))
    expect(byPath.get('pages/Home.tsx')).toBe(true)
    expect(byPath.get('pages/ByHand.tsx')).toBe(false)
  })

  it('filters excluded directories out of status and says how many it withheld', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.studio', 'meta.json'), '{}')
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')

    const status = (await (await call(`/admin/api/studio/git/status?dir=${encodeURIComponent(dir)}`)).json()) as {
      status: { entries: Array<{ path: string }>; excludedCount: number }
    }
    expect(status.status.entries.map((e) => e.path)).toEqual(['pages/Home.tsx'])
    expect(status.status.excludedCount).toBeGreaterThan(0)
  })
})
