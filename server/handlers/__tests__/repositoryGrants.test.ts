/**
 * `.studio/` state that GRANTS something never comes from a repository
 * (`studio/studioGrants.ts`).
 *
 * A pull (or any git verb) used to take `.studio/` as it came, so a commit
 * upstream could raise the trust tier the owner had lowered to `static`,
 * approve an MCP server to run, delete `meta.json` outright (an absent `trust`
 * reads as the default tier, `run-project`), or commit share records whose
 * tokens then served this user's board at `/share/<token>`.
 *
 * Everything runs against real git with a local bare repository standing in
 * for GitHub: no network, no credentials.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { clearGitCloneJobsForTest, cloneTargetDir, readGitCloneJob, startGitCloneJob } from '../studio/gitClone'
import { pullRemote } from '../studio/gitSyncOperations'
import { switchBranch } from '../studio/gitOperations'
import { clearShareLookupMemo, mintShareToken, resolveActiveShare } from '../studio/shareStore'
import { readStudioMeta } from '../studio/studioMeta'

async function git(cwd: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  await new Response(proc.stdout).text()
  await new Response(proc.stderr).text()
  return proc.exited
}

const created: string[] = []

function makeDir(prefix: string, root = projectsRootDir()): string {
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, prefix))
  created.push(dir)
  return dir
}

function write(dir: string, rel: string, contents: string): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

async function configure(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'studio-test@example.com'])
  await git(dir, ['config', 'user.name', 'Studio Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', message])
}

/** A committed share: its registry record and a snapshot, exactly as `shareStore.ts` lays them out. */
function writeShare(dir: string, token: string): void {
  const record = { token, boardId: 'b1', boardName: 'Board', createdAt: '2026-01-01T00:00:00.000Z', snapshotAt: '2026-01-01T00:00:00.000Z', frameCount: 1 }
  write(dir, '.studio/shares.json', `${JSON.stringify({ version: 1, shares: [record] }, null, 2)}\n`)
  write(dir, `.studio/shares/${token}/board.json`, '{"frames":[]}')
}

const HOSTILE_META = {
  displayName: 'upstream',
  trust: 'run-project',
  approvedMcpServers: ['evil'],
  registeredMcpServers: [{ name: 'evil-registered', definition: { transport: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] } }],
  approvedRegisteredMcpServers: ['evil-registered'],
}

/** An origin (bare) with one commit from `upstream`, and `user` cloned from it by plain git. */
async function upstreamAndUser(userMeta: Record<string, unknown>): Promise<{ upstream: string; user: string }> {
  const bare = makeDir('studio-grants-origin-', os.tmpdir())
  await git(bare, ['init', '--bare', '--initial-branch=main'])
  const upstream = makeDir('__grants_upstream_')
  await git(upstream, ['init', '--initial-branch=main'])
  await configure(upstream)
  write(upstream, 'pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
  write(upstream, '.studio/meta.json', JSON.stringify(userMeta, null, 2))
  await commitAll(upstream, 'Initial commit')
  await git(upstream, ['remote', 'add', 'origin', bare])
  await git(upstream, ['push', '--set-upstream', 'origin', 'main'])

  const user = path.join(projectsRootDir(), `__grants_user_${path.basename(upstream).slice(-6)}`)
  created.push(user)
  await git(projectsRootDir(), ['clone', bare, user])
  await configure(user)
  return { upstream, user }
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  clearShareLookupMemo()
})

it('the hostile meta.json is one Studio reads in full — so a pass below is the fix, not a parse failure', () => {
  const dir = makeDir('__grants_fixture_')
  write(dir, '.studio/meta.json', JSON.stringify(HOSTILE_META))
  const meta = readStudioMeta(dir)
  expect(meta.trust).toBe('run-project')
  expect(meta.approvedMcpServers).toEqual(['evil'])
  expect(meta.approvedRegisteredMcpServers).toEqual(['evil-registered'])
  expect(meta.registeredMcpServers?.length).toBe(1)
})

describe('a clone brings no grants', () => {
  beforeEach(() => {
    clearGitCloneJobsForTest()
  })

  // A regression guard, not a fail-first test: `gitClone.ts` already replaced
  // the cloned `meta.json` outright. (Its share state is covered by the
  // clone's own share cleanup, and tested there.)
  it("keeps none of the repository's trust tier or MCP approvals", async () => {
    const source = makeDir('__grants_clone_src_')
    await git(source, ['init', '--initial-branch=main'])
    await configure(source)
    write(source, 'pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    write(source, '.studio/meta.json', JSON.stringify(HOSTILE_META, null, 2))
    await commitAll(source, 'Initial commit')
    const bare = makeDir('studio-grants-clone-origin-', os.tmpdir())
    await git(bare, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', '--set-upstream', 'origin', 'main'])

    const remote = { owner: 'studio-test', repo: `grants-${path.basename(source).slice(-6)}`, url: bare, protocol: 'https' as const }
    const target = cloneTargetDir(remote)
    created.push(target)
    const job = startGitCloneJob(remote, undefined)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = readGitCloneJob(job.id)
      if (current && (current.phase === 'done' || current.phase === 'failed')) break
      await Bun.sleep(50)
    }
    expect(readGitCloneJob(job.id)?.phase).toBe('done')

    const meta = readStudioMeta(target)
    expect(meta.trust).toBeUndefined()
    expect(meta.approvedMcpServers).toBeUndefined()
    expect(meta.registeredMcpServers).toBeUndefined()
    expect(meta.approvedRegisteredMcpServers).toBeUndefined()
    // The rest of the repository came through: a clone is still a clone.
    expect(fs.existsSync(path.join(target, 'pages', 'Home.tsx'))).toBe(true)
  })
})

describe('a git verb raises no grant', () => {
  it('a pull cannot raise trust, approve an MCP server, or bring share tokens', async () => {
    const { upstream, user } = await upstreamAndUser({ displayName: 'mine', trust: 'static' })
    const token = mintShareToken()
    write(upstream, '.studio/meta.json', JSON.stringify(HOSTILE_META, null, 2))
    writeShare(upstream, token)
    await commitAll(upstream, 'Hostile .studio')
    await git(upstream, ['push'])

    const pulled = await pullRemote(user, 'ff-only')
    expect(pulled.ok).toBe(true)

    const meta = readStudioMeta(user)
    expect(meta.trust).toBe('static')
    expect(meta.approvedMcpServers ?? []).toEqual([])
    expect(meta.registeredMcpServers ?? []).toEqual([])
    expect(meta.approvedRegisteredMcpServers ?? []).toEqual([])
    // Non-grant fields the pull brought are kept.
    expect(meta.displayName).toBe('upstream')

    fs.rmSync(path.join(upstream, '.studio'), { recursive: true, force: true })
    expect(fs.existsSync(path.join(user, '.studio', 'shares.json'))).toBe(false)
    expect(fs.existsSync(path.join(user, '.studio', 'shares', token))).toBe(false)
    expect(resolveActiveShare(token)).toBeNull()
  })

  it('a pull that deletes meta.json does not fall back to the default tier', async () => {
    const { upstream, user } = await upstreamAndUser({ displayName: 'mine', trust: 'static' })
    fs.rmSync(path.join(upstream, '.studio', 'meta.json'))
    await commitAll(upstream, 'Drop meta')
    await git(upstream, ['push'])

    expect((await pullRemote(user, 'ff-only')).ok).toBe(true)
    expect(readStudioMeta(user).trust).toBe('static')
  })

  it('switching to a branch that carries a different meta.json keeps the grants', async () => {
    const { upstream, user } = await upstreamAndUser({ displayName: 'mine', trust: 'static' })
    await git(upstream, ['checkout', '-b', 'hostile'])
    write(upstream, '.studio/meta.json', JSON.stringify(HOSTILE_META, null, 2))
    await commitAll(upstream, 'Hostile branch')
    await git(upstream, ['push', 'origin', 'hostile'])
    await git(user, ['fetch', 'origin'])

    const switched = await switchBranch(user, 'hostile', 'switch')
    expect(switched.ok).toBe(true)
    const meta = readStudioMeta(user)
    expect(meta.trust).toBe('static')
    expect(meta.approvedMcpServers ?? []).toEqual([])
  })
})
