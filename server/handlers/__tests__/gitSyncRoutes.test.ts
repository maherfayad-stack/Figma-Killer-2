/**
 * gitSyncRoutes — branches, fetch, pull, conflict resolution and pull requests,
 * end-to-end against REAL `git`, in a real project directory inside
 * `projectsRootDir()` so the containment guard passes.
 *
 * Everything that touches a remote runs against a **local bare repository**
 * created by the test. That is a real push/fetch/pull over git's own transport
 * with no network, no credentials, and no GitHub — which is the only honest
 * way to test "did the divergence actually change" without making the suite
 * depend on someone's account.
 *
 * The rejections are tested harder than the happy path, because they are the
 * security control: a `dir` outside the workspace, a project with no `.git` of
 * its own (which without the guard would resolve to **Studio's own
 * repository**), unusable paths in every path-taking route, and the rule that
 * no error body ever names a filesystem path.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProjectDirOutsideWorkspaceError, projectsRootDir } from '../studioProjects'
import { tryServeStudioGitSync } from '../studio/gitSyncRoutes'
import { originAcceptsStoredGithubToken } from '../studio/gitOperations'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  return { code: await proc.exited, out, err }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function call(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const res = await tryServeStudioGitSync(new Request(url, init), url, url.pathname)
  if (!res) throw new Error(`no route matched ${pathAndQuery}`)
  return res
}

/**
 * Read a working-tree file with line endings normalised.
 *
 * `core.autocrlf` is on by default on Windows, so a file git CHECKED OUT (a
 * pull, a `checkout --ours`) comes back with CRLF while one this test wrote
 * has LF. Comparing raw bytes would make every assertion below pass or fail on
 * the developer's git config rather than on Studio's behaviour, which is not
 * what any of them are about.
 */
function readTree(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n')
}

const created: string[] = []

function makeProjectDir(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, '__git_sync_test_'))
  created.push(dir)
  return dir
}

async function configure(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'studio-test@example.com'])
  await git(dir, ['config', 'user.name', 'Studio Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  // An empty value CLEARS the helper list. Without it, a network verb with no
  // credential invokes the host's helper — on Windows that is Git Credential
  // Manager, which opens a GUI dialog and blocks for the full
  // `GIT_NETWORK_TIMEOUT_MS`. Every remote below is a local bare repository
  // reached by path, so no helper has anything to contribute anyway.
  await git(dir, ['config', 'credential.helper', ''])
}

async function makeRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main'])
  await configure(dir)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return null }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'Initial commit'])
}

/** A bare repository on disk, wired up as `origin` with `main` pushed. Real transport, no network. */
async function makeBareRemote(dir: string): Promise<string> {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-sync-remote-'))
  created.push(remote)
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(dir, ['remote', 'add', 'origin', remote])
  await git(dir, ['push', '--set-upstream', 'origin', 'main'])
  return remote
}

afterAll(() => {
  // Per-entry, so one undeletable fixture cannot leave every later one behind
  // in `projectsRootDir()` where another suite's project discovery will find it.
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.error('[gitSyncRoutes.test] could not remove a fixture:', err)
    }
  }
})

// ---------------------------------------------------------------------------
// GET branches
// ---------------------------------------------------------------------------

interface BranchesBody {
  branches: Array<{
    name: string
    remote: boolean
    current: boolean
    upstream: string | null
    ahead: number | null
    behind: number | null
    upstreamGone: boolean
  }>
  current: string | null
  defaultBranch: string | null
}

describe('GET git/branches', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
  })

  it('lists local branches, names the current one, and reports no upstream when there is none', async () => {
    await git(dir, ['branch', 'feat/sidebar'])

    const res = await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as BranchesBody

    expect(body.current).toBe('main')
    expect(body.branches.map((b) => b.name).sort()).toEqual(['feat/sidebar', 'main'])
    expect(body.branches.every((b) => !b.remote)).toBe(true)
    expect(body.branches.find((b) => b.name === 'main')?.current).toBe(true)
    expect(body.branches.find((b) => b.name === 'main')?.upstream).toBeNull()
    expect(body.defaultBranch).toBeNull()
  })

  it('reports the upstream and the real ahead/behind against a local bare remote', async () => {
    await makeBareRemote(dir)

    // One commit here that the remote does not have.
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <main /> }\n')
    await git(dir, ['commit', '-am', 'Local work'])

    const body = (await (await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(dir)}`)).json()) as BranchesBody
    const main = body.branches.find((b) => b.name === 'main' && !b.remote)
    expect(main?.upstream).toBe('origin/main')
    expect(main?.ahead).toBe(1)
    expect(main?.behind).toBe(0)

    // The remote-tracking ref is listed too, and never carries an upstream of
    // its own — it IS one.
    const tracking = body.branches.find((b) => b.remote)
    expect(tracking?.name).toBe('origin/main')
    expect(tracking?.upstream).toBeNull()
  })

  it('reports a branch whose upstream was deleted as gone, not as up to date', async () => {
    const remote = await makeBareRemote(dir)
    await git(dir, ['switch', '--create', 'feat/temporary'])
    await git(dir, ['push', '--set-upstream', 'origin', 'feat/temporary'])
    // Someone deleted the branch on the remote.
    await git(remote, ['branch', '-D', 'feat/temporary'])
    await git(dir, ['fetch', '--prune', 'origin'])

    const body = (await (await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(dir)}`)).json()) as BranchesBody
    const gone = body.branches.find((b) => b.name === 'feat/temporary')
    expect(gone?.upstreamGone).toBe(true)
    expect(gone?.ahead).toBeNull()
    expect(gone?.behind).toBeNull()
  })

  it('never lists origin/HEAD as a branch — it is a symbolic ref, not something to check out', async () => {
    const remote = await makeBareRemote(dir)
    await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(dir, ['remote', 'set-head', 'origin', '--auto'])

    const body = (await (await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(dir)}`)).json()) as BranchesBody
    expect(body.branches.map((b) => b.name)).not.toContain('origin/HEAD')
    expect(body.defaultBranch).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// POST commit-and-switch
// ---------------------------------------------------------------------------

describe('POST git/commit-and-switch', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
    await git(dir, ['branch', 'feat/next'])
  })

  it('commits exactly the named files and lands on the other branch', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <main /> }\n')

    const res = await call(
      '/admin/api/studio/git/commit-and-switch',
      post({ dir, message: 'Draft the home page', files: ['pages/Home.tsx'], switch: 'feat/next' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; branch: string; files: string[]; shortSha: string }
    expect(body).toMatchObject({ ok: true, branch: 'feat/next', files: ['pages/Home.tsx'] })

    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()).toBe('feat/next')
    // The commit landed on `main`, where the work was done — not on the branch
    // that was switched to.
    expect((await git(dir, ['log', '--format=%s', 'main'])).out).toContain('Draft the home page')
  })

  it('keeps the commit but refuses the switch when files the user did not tick are still dirty', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <main /> }\n')
    fs.writeFileSync(path.join(dir, 'pages', 'About.tsx'), 'export default function About() { return null }\n')

    const res = await call(
      '/admin/api/studio/git/commit-and-switch',
      post({ dir, message: 'Only the home page', files: ['pages/Home.tsx'], switch: 'feat/next' }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; dirtyFiles: string[]; error: string }
    expect(body.code).toBe('dirty-tree')
    expect(body.dirtyFiles).toContain('pages/About.tsx')
    // The commit stands — silently rolling it back would be the surprise.
    expect((await git(dir, ['log', '--format=%s', 'main'])).out).toContain('Only the home page')
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()).toBe('main')
    expect(body.error).not.toContain(dir)
  })

  it('refuses a branch name that would be read as a flag BEFORE it commits anything', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')

    const res = await call(
      '/admin/api/studio/git/commit-and-switch',
      post({ dir, message: 'x', files: ['pages/Home.tsx'], switch: '--force' }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid-branch-name' })
    // Nothing was committed: the refusal came first.
    expect((await git(dir, ['log', '--format=%s'])).out.trim()).toBe('Initial commit')
  })
})

// ---------------------------------------------------------------------------
// Fetch and pull
// ---------------------------------------------------------------------------

/**
 * A second working copy of the same bare remote, standing in for "somebody
 * else pushed". Every remote interaction below is real git over its own local
 * transport — no network, no credentials, no GitHub.
 */
async function makeCollaborator(remote: string): Promise<string> {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-other-'))
  created.push(other)
  await git(other, ['clone', remote, '.'])
  await configure(other)
  return other
}

describe('POST git/fetch and git/pull', () => {
  let dir: string
  let remote: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
    remote = await makeBareRemote(dir)
  })

  it('fetch makes a collaborator\'s commit visible as "behind" without touching the working tree', async () => {
    const other = await makeCollaborator(remote)
    fs.writeFileSync(path.join(other, 'pages', 'Home.tsx'), 'export default function Home() { return <b /> }\n')
    await git(other, ['commit', '-am', 'Their work'])
    await git(other, ['push', 'origin', 'main'])

    const before = readTree(dir, 'pages/Home.tsx')
    const res = await call('/admin/api/studio/git/fetch', post({ dir }))
    expect(res.status).toBe(200)
    // A fetch changes refs, never files.
    expect(readTree(dir, 'pages/Home.tsx')).toBe(before)

    const body = (await (await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(dir)}`)).json()) as BranchesBody
    expect(body.branches.find((b) => b.name === 'main' && !b.remote)?.behind).toBe(1)
  })

  it('a ff-only pull fast-forwards and the working tree really changes', async () => {
    const other = await makeCollaborator(remote)
    fs.writeFileSync(path.join(other, 'pages', 'Home.tsx'), 'THEIRS\n')
    await git(other, ['commit', '-am', 'Their work'])
    await git(other, ['push', 'origin', 'main'])

    const res = await call('/admin/api/studio/git/pull', post({ dir }))
    expect(res.status).toBe(200)
    expect((await res.json()) as { strategy: string }).toMatchObject({ ok: true, strategy: 'ff-only' })
    expect(readTree(dir, 'pages/Home.tsx')).toBe('THEIRS\n')
  })

  it('refuses a pull over uncommitted work and names the files — Studio never stashes', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'my unsaved screen\n')

    const res = await call('/admin/api/studio/git/pull', post({ dir }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; dirtyFiles: string[]; error: string }
    expect(body.code).toBe('dirty-tree')
    expect(body.dirtyFiles).toContain('pages/Home.tsx')
    expect(body.error).not.toContain(dir)
    // Untouched.
    expect(readTree(dir, 'pages/Home.tsx')).toBe('my unsaved screen\n')
  })

  it('reports divergence as `diverged` rather than picking rebase or merge', async () => {
    const other = await makeCollaborator(remote)
    fs.writeFileSync(path.join(other, 'pages', 'About.tsx'), 'theirs\n')
    await git(other, ['add', '-A'])
    await git(other, ['commit', '-m', 'Their work'])
    await git(other, ['push', 'origin', 'main'])

    fs.writeFileSync(path.join(dir, 'pages', 'Mine.tsx'), 'mine\n')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', 'My work'])

    const res = await call('/admin/api/studio/git/pull', post({ dir }))
    expect(res.status).toBe(409)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'diverged' })
  })

  it('rejects a strategy the schema does not know', async () => {
    expect((await call('/admin/api/studio/git/pull', post({ dir, strategy: 'octopus' }))).status).toBe(400)
    expect((await call('/admin/api/studio/git/pull', post({ dir, strategy: '--force' }))).status).toBe(400)
  })

  it('refuses fetch and pull with no origin remote', async () => {
    const solo = makeProjectDir()
    await makeRepo(solo)
    expect((await call('/admin/api/studio/git/fetch', post({ dir: solo }))).status).toBe(409)
    expect((await call('/admin/api/studio/git/pull', post({ dir: solo }))).status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// The credential gate the network verbs share
// ---------------------------------------------------------------------------

/**
 * `GIT_ASKPASS` answers whatever host git dialled — it is handed a prompt
 * string, not a destination it can refuse. So a stored GitHub token passed to
 * an invocation whose `origin` is somebody else's server hands that server a
 * `repo`-scoped token for the whole account. `push` learned this in the
 * security review of PR #151; `fetch` and `pull` dial the same remote and go
 * through the same gate rather than re-deriving it, which is what these assert.
 */
describe('originAcceptsStoredGithubToken — the gate fetch and pull share with push', () => {
  it('refuses a local bare remote — exactly the shape every test above uses', async () => {
    const dir = makeProjectDir()
    await makeRepo(dir)
    await makeBareRemote(dir)
    expect(await originAcceptsStoredGithubToken(dir)).toBe(false)
  })

  it('refuses a project with no origin at all', async () => {
    const dir = makeProjectDir()
    await makeRepo(dir)
    expect(await originAcceptsStoredGithubToken(dir)).toBe(false)
  })

  it('accepts a github.com origin, in either URL shape', async () => {
    for (const url of ['https://github.com/acme/storefront.git', 'git@github.com:acme/storefront.git']) {
      const dir = makeProjectDir()
      await makeRepo(dir)
      await git(dir, ['remote', 'add', 'origin', url])
      expect({ url, accepted: await originAcceptsStoredGithubToken(dir) }).toEqual({ url, accepted: true })
    }
  })

  it('refuses a look-alike host and an executing transport', async () => {
    for (const url of [
      'https://github.com.evil.example/acme/storefront.git',
      'https://gitlab.com/acme/storefront.git',
      'ext::sh -c "curl evil.example"',
      'file:///tmp/somewhere',
    ]) {
      const dir = makeProjectDir()
      await makeRepo(dir)
      await git(dir, ['remote', 'add', 'origin', url])
      expect({ url, accepted: await originAcceptsStoredGithubToken(dir) }).toEqual({ url, accepted: false })
    }
  })
})

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * Puts `dir` and the remote in genuine conflict on the same line of the same
 * file, then pulls with `strategy` so the repository is really stopped
 * mid-rebase or mid-merge. Everything below asserts against that real state,
 * never a simulated one.
 */
async function provokeConflict(dir: string, remote: string, strategy: 'rebase' | 'merge'): Promise<Response> {
  const other = await makeCollaborator(remote)
  fs.writeFileSync(path.join(other, 'pages', 'Home.tsx'), 'THEIRS\n')
  await git(other, ['commit', '-am', 'Their version'])
  await git(other, ['push', 'origin', 'main'])

  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'MINE\n')
  await git(dir, ['commit', '-am', 'My version'])

  return call('/admin/api/studio/git/pull', post({ dir, strategy }))
}

describe('conflicts', () => {
  let dir: string
  let remote: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
    remote = await makeBareRemote(dir)
  })

  it('a conflicted rebase answers 409 with the unmerged files, and the state survives a fresh read', async () => {
    const res = await provokeConflict(dir, remote, 'rebase')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; files: string[]; error: string }
    expect(body.code).toBe('conflict')
    expect(body.files).toEqual(['pages/Home.tsx'])
    expect(body.error).not.toContain(dir)

    // Read back from the repository, not remembered — this is what makes the
    // panel able to show a conflict after a page reload.
    const state = (await (await call(`/admin/api/studio/git/conflicts?dir=${encodeURIComponent(dir)}`)).json()) as {
      kind: string | null
      files: string[]
    }
    expect(state.kind).toBe('rebase')
    expect(state.files).toEqual(['pages/Home.tsx'])
  })

  it('"Keep mine" during a REBASE keeps the user\'s version — git\'s --ours/--theirs invert there', async () => {
    await provokeConflict(dir, remote, 'rebase')

    const res = await call(
      '/admin/api/studio/git/conflict/resolve',
      post({ dir, file: 'pages/Home.tsx', side: 'mine' }),
    )
    expect(res.status).toBe(200)
    // THE assertion this whole translation exists for: during a rebase the
    // user's own commit is git's `--theirs`, so a naive `--ours` would have
    // silently kept the remote's version here.
    expect(readTree(dir, 'pages/Home.tsx')).toBe('MINE\n')
  })

  it('"Keep theirs" during a REBASE keeps the remote version', async () => {
    await provokeConflict(dir, remote, 'rebase')
    await call('/admin/api/studio/git/conflict/resolve', post({ dir, file: 'pages/Home.tsx', side: 'theirs' }))
    expect(readTree(dir, 'pages/Home.tsx')).toBe('THEIRS\n')
  })

  it('"Keep mine" during a MERGE keeps the user\'s version too — same word, opposite git flag', async () => {
    await provokeConflict(dir, remote, 'merge')
    await call('/admin/api/studio/git/conflict/resolve', post({ dir, file: 'pages/Home.tsx', side: 'mine' }))
    expect(readTree(dir, 'pages/Home.tsx')).toBe('MINE\n')
  })

  it('continue finishes the rebase once every file is resolved', async () => {
    await provokeConflict(dir, remote, 'rebase')
    await call('/admin/api/studio/git/conflict/resolve', post({ dir, file: 'pages/Home.tsx', side: 'mine' }))

    const res = await call('/admin/api/studio/git/conflict/continue', post({ dir }))
    expect(res.status).toBe(200)
    expect((await res.json()) as { kind: string }).toMatchObject({ ok: true, kind: 'rebase' })

    const state = (await (await call(`/admin/api/studio/git/conflicts?dir=${encodeURIComponent(dir)}`)).json()) as {
      kind: string | null
    }
    expect(state.kind).toBeNull()
  })

  it('refuses continue while a file is still unmerged, and names it', async () => {
    await provokeConflict(dir, remote, 'rebase')

    const res = await call('/admin/api/studio/git/conflict/continue', post({ dir }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; files: string[] }
    expect(body.code).toBe('unresolved-conflicts')
    expect(body.files).toEqual(['pages/Home.tsx'])
  })

  it('abort puts the branch back and requires the literal confirm', async () => {
    await provokeConflict(dir, remote, 'rebase')

    // The schema, not a handler branch, rejects an unconfirmed abort.
    expect((await call('/admin/api/studio/git/conflict/abort', post({ dir }))).status).toBe(400)
    expect((await call('/admin/api/studio/git/conflict/abort', post({ dir, confirm: false }))).status).toBe(400)

    const res = await call('/admin/api/studio/git/conflict/abort', post({ dir, confirm: true }))
    expect(res.status).toBe(200)
    expect(readTree(dir, 'pages/Home.tsx')).toBe('MINE\n')
    expect((await git(dir, ['log', '--format=%s', '-1'])).out.trim()).toBe('My version')
  })

  it('refuses resolve/continue/abort when nothing is in progress', async () => {
    for (const [route, body] of [
      ['/admin/api/studio/git/conflict/resolve', { dir, file: 'pages/Home.tsx', side: 'mine' }],
      ['/admin/api/studio/git/conflict/continue', { dir }],
      ['/admin/api/studio/git/conflict/abort', { dir, confirm: true }],
    ] as const) {
      const res = await call(route, post(body))
      expect({ route, status: res.status }).toEqual({ route, status: 409 })
      expect((await res.json()) as { code: string }).toMatchObject({ code: 'nothing-in-progress' })
    }
  })

  it('404s an unusable path in conflict/resolve', async () => {
    for (const file of ['../escape.tsx', '..\\escape.tsx', '/etc/passwd', 'node_modules/x.js', '.git/config']) {
      const res = await call('/admin/api/studio/git/conflict/resolve', post({ dir, file, side: 'mine' }))
      expect({ file, status: res.status }).toEqual({ file, status: 404 })
    }
  })

  it('rejects a side the schema does not know', async () => {
    expect(
      (await call('/admin/api/studio/git/conflict/resolve', post({ dir, file: 'pages/Home.tsx', side: 'ours' })))
        .status,
    ).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

interface PrContextBody {
  supported: boolean
  base: string | null
  head: string | null
  compareUrl: string | null
  isDefaultBranch: boolean
}

describe('pull requests', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
  })

  it('reports supported: false for a project with no origin — a state, not a failure', async () => {
    const res = await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    expect((await res.json()) as PrContextBody).toMatchObject({ supported: false, compareUrl: null })
  })

  it('reports supported: false for an origin that is not GitHub, without saying what it is', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-not-github-'))
    created.push(remote)
    await git(remote, ['init', '--bare', '--initial-branch=main'])
    await git(dir, ['remote', 'add', 'origin', remote])

    const res = await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as PrContextBody
    expect(body.supported).toBe(false)
    expect(JSON.stringify(body)).not.toContain(remote)
  })

  it('builds the compare URL from a GitHub origin, on either URL shape', async () => {
    for (const [url, label] of [
      ['https://github.com/acme/storefront.git', 'https'],
      ['git@github.com:acme/storefront.git', 'ssh'],
    ] as const) {
      const project = makeProjectDir()
      await makeRepo(project)
      await git(project, ['remote', 'add', 'origin', url])
      await git(project, ['switch', '--create', 'feat/sidebar'])

      const body = (await (
        await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(project)}`)
      ).json()) as PrContextBody
      expect({ label, ...body }).toMatchObject({
        label,
        supported: true,
        // No `origin/HEAD` on a remote nobody cloned from, so `main` is the default.
        base: 'main',
        head: 'feat/sidebar',
        compareUrl: 'https://github.com/acme/storefront/compare/main...feat/sidebar?expand=1',
        isDefaultBranch: false,
      })
    }
  })

  it('reports isDefaultBranch when you are standing on the base — a PR from it to itself has no meaning', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    const body = (await (
      await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(dir)}`)
    ).json()) as PrContextBody
    expect(body).toMatchObject({ supported: true, head: 'main', base: 'main', isDefaultBranch: true })
  })

  it('refuses to open a PR against a non-GitHub origin', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-not-github-post-'))
    created.push(remote)
    await git(remote, ['init', '--bare', '--initial-branch=main'])
    await git(dir, ['remote', 'add', 'origin', remote])

    const res = await call('/admin/api/studio/git/pull-request', post({ dir }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('not-a-github-remote')
    expect(body.error).not.toContain(remote)
    expect(body.error).not.toContain(dir)
  })

  it('refuses a PR from the base branch onto itself, and still offers the compare link', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    const res = await call('/admin/api/studio/git/pull-request', post({ dir }))
    expect(res.status).toBe(409)
    expect((await res.json()) as { code: string; compareUrl: string }).toMatchObject({
      code: 'same-branch',
      compareUrl: 'https://github.com/acme/storefront/compare/main...main?expand=1',
    })
  })

  it('answers no-github-token WITH the compare URL — nobody is signed in on this server', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    await git(dir, ['switch', '--create', 'feat/sidebar'])

    const res = await call('/admin/api/studio/git/pull-request', post({ dir }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; compareUrl: string; error: string }
    expect(body.code).toBe('no-github-token')
    expect(body.compareUrl).toBe('https://github.com/acme/storefront/compare/main...feat/sidebar?expand=1')
    expect(body.error).not.toContain(dir)
  })

  it('refuses a base branch that would be read as a flag', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    await git(dir, ['switch', '--create', 'feat/sidebar'])
    expect((await call('/admin/api/studio/git/pull-request', post({ dir, base: '--force' }))).status).toBe(400)
  })

  it('refuses a PR on a detached HEAD, and reports the context as unsupported there', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    const head = (await git(dir, ['rev-parse', 'HEAD'])).out.trim()
    await git(dir, ['checkout', '--detach', head])

    expect(
      ((await (
        await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(dir)}`)
      ).json()) as PrContextBody).supported,
    ).toBe(false)

    const res = await call('/admin/api/studio/git/pull-request', post({ dir }))
    expect(res.status).toBe(409)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'detached-head' })
  })
})

// ---------------------------------------------------------------------------
// Rejections — the security control
// ---------------------------------------------------------------------------

describe('gitSyncRoutes — rejections', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
  })

  it('refuses every route for a dir outside the workspace, before any git runs', async () => {
    // `resolveProjectDir` throws; `rethrowProjectDirRefusal` lets it past this
    // sub-router so the top-level router answers with its single bare 404 —
    // the same contract `git.ts` has. Asserting the throw is asserting that
    // contract, not bypassing it.
    await withOutsideWorkspaceDir('git-sync-outside', async (outside) => {
      await makeRepo(outside)
      const refused = (pending: Promise<unknown>) =>
        expect(pending).rejects.toThrow(ProjectDirOutsideWorkspaceError)

      await refused(call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(outside)}`))
      await refused(
        call(
          '/admin/api/studio/git/commit-and-switch',
          post({ dir: outside, message: 'x', files: ['a.tsx'], switch: 'main' }),
        ),
      )
      await refused(call('/admin/api/studio/git/fetch', post({ dir: outside })))
      await refused(call('/admin/api/studio/git/pull', post({ dir: outside })))
      await refused(call(`/admin/api/studio/git/conflicts?dir=${encodeURIComponent(outside)}`))
      await refused(
        call('/admin/api/studio/git/conflict/resolve', post({ dir: outside, file: 'a.tsx', side: 'mine' })),
      )
      await refused(call('/admin/api/studio/git/conflict/continue', post({ dir: outside })))
      await refused(call('/admin/api/studio/git/conflict/abort', post({ dir: outside, confirm: true })))
      await refused(call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(outside)}`))
      await refused(call('/admin/api/studio/git/pull-request', post({ dir: outside })))
    })
  })

  it('404s a project with no repository of its own — the guard that stops git finding Studio\'s own repo', async () => {
    const bare = makeProjectDir()
    fs.writeFileSync(path.join(bare, 'App.tsx'), 'export const App = () => null\n')
    expect(fs.existsSync(path.join(bare, '.git'))).toBe(false)

    expect((await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(bare)}`)).status).toBe(404)
    expect(
      (
        await call(
          '/admin/api/studio/git/commit-and-switch',
          post({ dir: bare, message: 'x', files: ['App.tsx'], switch: 'main' }),
        )
      ).status,
    ).toBe(404)
    expect((await call('/admin/api/studio/git/fetch', post({ dir: bare }))).status).toBe(404)
    expect((await call('/admin/api/studio/git/pull', post({ dir: bare }))).status).toBe(404)
    expect((await call(`/admin/api/studio/git/conflicts?dir=${encodeURIComponent(bare)}`)).status).toBe(404)
    expect((await call('/admin/api/studio/git/conflict/continue', post({ dir: bare }))).status).toBe(404)
    expect((await call(`/admin/api/studio/git/pull-request/context?dir=${encodeURIComponent(bare)}`)).status).toBe(404)
    expect((await call('/admin/api/studio/git/pull-request', post({ dir: bare }))).status).toBe(404)
  })

  it('404s the workspace root itself', async () => {
    const root = projectsRootDir()
    expect((await call(`/admin/api/studio/git/branches?dir=${encodeURIComponent(root)}`)).status).toBe(404)
  })

  it('404s an unusable path in commit-and-switch — traversal on either separator, absolute, excluded', async () => {
    for (const file of [
      '../escape.tsx',
      '..\\escape.tsx',
      'pages/../../escape.tsx',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'node_modules/left-pad/index.js',
      '.studio/meta.json',
      '.git/config',
    ]) {
      const res = await call(
        '/admin/api/studio/git/commit-and-switch',
        post({ dir, message: 'x', files: [file], switch: 'main' }),
      )
      expect({ file, status: res.status }).toEqual({ file, status: 404 })
    }
  })

  it('rejects a body the schema does not accept rather than guessing', async () => {
    // Empty file list — there is no "commit everything" shape on this wire.
    expect(
      (await call('/admin/api/studio/git/commit-and-switch', post({ dir, message: 'x', files: [], switch: 'main' })))
        .status,
    ).toBe(400)
    // No message.
    expect(
      (await call('/admin/api/studio/git/commit-and-switch', post({ dir, files: ['pages/Home.tsx'], switch: 'main' })))
        .status,
    ).toBe(400)
    // Blank message.
    expect(
      (
        await call(
          '/admin/api/studio/git/commit-and-switch',
          post({ dir, message: '   ', files: ['pages/Home.tsx'], switch: 'main' }),
        )
      ).status,
    ).toBe(400)
    // No branch to switch to.
    expect(
      (
        await call(
          '/admin/api/studio/git/commit-and-switch',
          post({ dir, message: 'x', files: ['pages/Home.tsx'], switch: '  ' }),
        )
      ).status,
    ).toBe(400)
  })

  it('does not answer a method or action it does not own', async () => {
    const url = new URL('http://localhost/admin/api/studio/git/branches')
    expect(await tryServeStudioGitSync(new Request(url, { method: 'POST' }), url, url.pathname)).toBeNull()
    const other = new URL('http://localhost/admin/api/studio/git/status')
    expect(await tryServeStudioGitSync(new Request(other), other, other.pathname)).toBeNull()
  })
})
