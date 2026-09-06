/**
 * deploy — W5-4 preview deploys.
 *
 * **A real deploy cannot run in CI**, and pretending otherwise would be the
 * worst kind of green test: it needs the `vercel`/`netlify` CLI installed, a
 * logged-in account, a linked remote project, and the network. So this file
 * tests everything up to and including the subprocess boundary, and stops
 * there:
 *
 *   1. **Detection** — pure `existsSync` logic over a real temp project.
 *   2. **Output parsing** — the preview URL and the auth state, read out of
 *      REAL captured CLI transcripts (below). This is the part most likely to
 *      break silently when a CLI reformats its output, and the part a mock
 *      cannot honestly stand in for, so the fixtures are verbatim.
 *   3. **The capability gate** — Tier 0/1 refuses, Tier 2 does not. The gate is
 *      the security control, so it is tested through the ROUTE, not through the
 *      job function it protects.
 *   4. **Route validation** — a body without `confirm`, a `dir` outside the
 *      workspace, an unknown job id.
 *   5. **The whole pipeline against a FAKE CLI** injected through the same
 *      `spawn` seam `installDeps.test.ts` uses: check → build → deploy, the
 *      exact argv each phase runs (asserted to contain no `--prod`), the parsed
 *      URL, and the `lastDeploy` record left in `.studio/meta.json`.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioDeploy } from '../studio/deploy'
import { detectDeployProviders, parseAuthProbe, parsePreviewUrl, mentionsUnlinkedProject } from '../studio/deployProviders'
import { resolveDeployJob, startDeployJob } from '../studio/deployJobs'
import { readStudioMeta, writeStudioMeta } from '../studio/studioMeta'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../studio/subprocessRunner'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const created: string[] = []

function makeProjectDir(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, '__deploy_test_'))
  created.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'deploy-fixture', version: '0.0.0' }))
  return dir
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

function call(pathAndQuery: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return tryServeStudioDeploy(new Request(url, init), url, url.pathname)
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

interface FakeResponse {
  stdout?: string
  stderr?: string
  code?: number
}

/**
 * A fake CLI: an argv → canned-output table plus a recording of every argv
 * that was actually run. Everything before `Bun.spawn` is the real code path —
 * env construction, the byte cap, the timeout race, the output parsing.
 */
function fakeCli(table: Record<string, FakeResponse>): { spawn: SubprocessSpawnFn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SubprocessSpawnFn = (argv) => {
    calls.push([...argv])
    const response = table[argv.join(' ')] ?? { code: 127, stderr: `unexpected argv: ${argv.join(' ')}` }
    const proc: SpawnedProcessLike = {
      stdout: streamOf(response.stdout ?? ''),
      stderr: streamOf(response.stderr ?? ''),
      exited: Promise.resolve(response.code ?? 0),
      kill() {
        // nothing to kill — the fake process has already finished
      },
    }
    return proc
  }
  return { spawn, calls }
}

async function waitForJob(id: string, dir: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = resolveDeployJob(id, dir)
    if (job && job.status !== 'running') return job
    await Bun.sleep(10)
  }
  throw new Error('the deploy job never reached a terminal status')
}

// ---------------------------------------------------------------------------
// Real captured CLI output
// ---------------------------------------------------------------------------

/** `vercel deploy --prebuilt`. The `Inspect:` line above `Preview:` is a dashboard URL — the trap a positional "first https://" match falls into. */
const VERCEL_DEPLOY_OUTPUT = `Vercel CLI 39.3.0
Retrieving project…
Deploying studio/preview-fixture
Uploading [====================] (2.4MB/2.4MB)
Inspect: https://vercel.com/studio/preview-fixture/8kQvJ2s1RtY [2s]
Preview: https://preview-fixture-8kqvj2s1-studio.vercel.app [5s]
Queued
Building
Completing
`

/** `netlify deploy`. `Build logs:` sits above the two URL lines, for the same reason. */
const NETLIFY_DEPLOY_OUTPUT = `Deploy path:        /work/preview-fixture/dist
Configuration path: /work/preview-fixture/netlify.toml
Deploying to draft URL...
✔ Finished hashing 24 files
✔ CDN requesting 3 files
✔ Finished uploading 3 assets
✔ Deploy is live!

Build logs:         https://app.netlify.com/sites/preview-fixture/deploys/665f0
Function logs:      https://app.netlify.com/sites/preview-fixture/logs/functions
Unique deploy URL:  https://665f0a1b--preview-fixture.netlify.app
Website draft URL:  https://665f0a1b--preview-fixture.netlify.app
`

const NETLIFY_STATUS_OUTPUT = `──────────────────────┐
 Current Netlify User │
──────────────────────┘
Name:  Studio Tester
Email: tester@example.com
Teams: Studio: Collaborator

────────────────────┐
 Netlify Site Info  │
────────────────────┘
Current site: preview-fixture
Admin URL:    https://app.netlify.com/sites/preview-fixture
Site Id:      1a2b3c
`

// ---------------------------------------------------------------------------
// 1 — detection
// ---------------------------------------------------------------------------

describe('provider detection', () => {
  it('reads vercel.json as Vercel and netlify.toml as Netlify', () => {
    const vercelDir = makeProjectDir()
    fs.writeFileSync(path.join(vercelDir, 'vercel.json'), '{}')
    expect(detectDeployProviders(vercelDir).detected).toBe('vercel')
    expect(detectDeployProviders(vercelDir).vercel.config).toBe(true)

    const netlifyDir = makeProjectDir()
    fs.writeFileSync(path.join(netlifyDir, 'netlify.toml'), '[build]\n')
    expect(detectDeployProviders(netlifyDir).detected).toBe('netlify')
  })

  it('reports a linked directory even with no config file', () => {
    const dir = makeProjectDir()
    fs.mkdirSync(path.join(dir, '.vercel'))
    fs.writeFileSync(path.join(dir, '.vercel', 'project.json'), '{"projectId":"x"}')
    const detection = detectDeployProviders(dir)
    expect(detection.detected).toBe('vercel')
    expect(detection.vercel).toEqual({ config: false, linked: true })
  })

  it('detects nothing when the project configures neither — the panel offers both', () => {
    const detection = detectDeployProviders(makeProjectDir())
    expect(detection.detected).toBeNull()
    expect(detection.vercel).toEqual({ config: false, linked: false })
    expect(detection.netlify).toEqual({ config: false, linked: false })
  })

  it('refuses to guess when the project configures BOTH', () => {
    const dir = makeProjectDir()
    fs.writeFileSync(path.join(dir, 'vercel.json'), '{}')
    fs.writeFileSync(path.join(dir, 'netlify.toml'), '[build]\n')
    expect(detectDeployProviders(dir).detected).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2 — reading the CLIs' answers back
// ---------------------------------------------------------------------------

describe('preview URL parsing', () => {
  it('takes Vercel’s Preview line, not the Inspect dashboard link above it', () => {
    expect(parsePreviewUrl('vercel', '', VERCEL_DEPLOY_OUTPUT)).toBe(
      'https://preview-fixture-8kqvj2s1-studio.vercel.app',
    )
  })

  it('takes the bare deployment URL Vercel writes to stdout when no label is present', () => {
    expect(parsePreviewUrl('vercel', 'https://preview-fixture-8kqvj2s1-studio.vercel.app\n', '')).toBe(
      'https://preview-fixture-8kqvj2s1-studio.vercel.app',
    )
  })

  it('takes Netlify’s draft URL, not its build-log link', () => {
    expect(parsePreviewUrl('netlify', NETLIFY_DEPLOY_OUTPUT, '')).toBe(
      'https://665f0a1b--preview-fixture.netlify.app',
    )
  })

  it('survives ANSI colour codes around the URL', () => {
    const esc = '\u001b'
    const coloured = `Preview: ${esc}[36mhttps://coloured-abc.vercel.app${esc}[39m [3s]\n`
    expect(parsePreviewUrl('vercel', '', coloured)).toBe('https://coloured-abc.vercel.app')
  })

  it('returns null rather than inventing a URL when the output has none', () => {
    expect(parsePreviewUrl('vercel', 'Error: build failed\n', '')).toBeNull()
    expect(parsePreviewUrl('netlify', 'Build logs: https://app.netlify.com/sites/x/deploys/1\n', '')).toBeNull()
  })
})

describe('auth probe parsing', () => {
  it('reads a signed-in Vercel account off whoami', () => {
    expect(parseAuthProbe('vercel', { stdout: 'studio-tester\n', stderr: '> 0.1s\n', exitCode: 0 })).toEqual({
      authenticated: true,
      account: 'studio-tester',
    })
  })

  it('reads a signed-out Vercel CLI', () => {
    expect(
      parseAuthProbe('vercel', { stdout: '', stderr: 'Error: You are not currently logged in.\n', exitCode: 1 }),
    ).toEqual({ authenticated: false, account: null })
  })

  it('reads a signed-in Netlify account off status', () => {
    expect(parseAuthProbe('netlify', { stdout: NETLIFY_STATUS_OUTPUT, stderr: '', exitCode: 0 })).toEqual({
      authenticated: true,
      account: 'tester@example.com',
    })
  })

  it('reads a signed-out Netlify CLI even though it exits 0', () => {
    expect(
      parseAuthProbe('netlify', {
        stdout: "You are not currently logged in. Please log in with `netlify login`.\n",
        stderr: '',
        exitCode: 0,
      }),
    ).toEqual({ authenticated: false, account: null })
  })

  it('recognises an unlinked directory from either CLI', () => {
    expect(mentionsUnlinkedProject("Error: Your codebase isn't linked to a project on Vercel.")).toBe(true)
    expect(mentionsUnlinkedProject('It looks like this folder is not linked to a site. Run `netlify link`.')).toBe(true)
    expect(mentionsUnlinkedProject('Deploy is live!')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3 — the capability gate
// ---------------------------------------------------------------------------

describe('the trust-tier gate', () => {
  it('refuses to start a deploy at Tier 0 (static)', async () => {
    const dir = makeProjectDir()
    const res = await call('/admin/api/studio/deploy', post({ dir, provider: 'vercel', confirm: true }))
    expect(res?.status).toBe(409)
    const body = (await res!.json()) as { code: string; error: string }
    expect(body.code).toBe('trust-tier-required')
    expect(body.error).toContain('run-project')
  })

  it('refuses at Tier 1 (render-packages) too — bundling packages is not building the app', async () => {
    const dir = makeProjectDir()
    writeStudioMeta(dir, { trust: 'render-packages' })
    const res = await call('/admin/api/studio/deploy', post({ dir, provider: 'netlify', confirm: true }))
    expect(res?.status).toBe(409)
  })

  it('reports the gate as data, and spawns no CLI below it', async () => {
    const dir = makeProjectDir()
    fs.writeFileSync(path.join(dir, 'vercel.json'), '{}')
    const res = await call(`/admin/api/studio/deploy/status?dir=${encodeURIComponent(dir)}`)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      trust: string
      canDeploy: boolean
      gateMessage: string | null
      providers: unknown
      detection: { detected: string | null }
    }
    expect(body.trust).toBe('static')
    expect(body.canDeploy).toBe(false)
    expect(body.gateMessage).toContain('run-project')
    // The detection is a file read and is always answered; the CLI probe is not.
    expect(body.detection.detected).toBe('vercel')
    expect(body.providers).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4 — route validation
// ---------------------------------------------------------------------------

describe('route validation', () => {
  it('rejects a body with no confirm, and one with an unknown provider', async () => {
    const dir = makeProjectDir()
    writeStudioMeta(dir, { trust: 'run-project' })
    expect((await call('/admin/api/studio/deploy', post({ dir, provider: 'vercel' })))?.status).toBe(400)
    expect((await call('/admin/api/studio/deploy', post({ dir, provider: 'vercel', confirm: false })))?.status).toBe(400)
    expect((await call('/admin/api/studio/deploy', post({ dir, provider: 'heroku', confirm: true })))?.status).toBe(400)
  })

  it('404s a dir outside the workspace, and the workspace root itself', async () => {
    const outside = path.join(projectsRootDir(), '..', '..')
    expect((await call(`/admin/api/studio/deploy/status?dir=${encodeURIComponent(outside)}`))?.status).toBe(404)
    expect(
      (await call('/admin/api/studio/deploy', post({ dir: outside, provider: 'vercel', confirm: true })))?.status,
    ).toBe(404)
    expect(
      (await call(`/admin/api/studio/deploy/status?dir=${encodeURIComponent(projectsRootDir())}`))?.status,
    ).toBe(404)
  })

  it('404s an unknown job id', async () => {
    const dir = makeProjectDir()
    const res = await call(`/admin/api/studio/deploy/not-a-job?dir=${encodeURIComponent(dir)}`)
    expect(res?.status).toBe(404)
  })

  it('does not claim routes it does not own', async () => {
    expect(await call('/admin/api/studio/git/status')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5 — the pipeline, against a fake CLI
// ---------------------------------------------------------------------------

describe('the deploy pipeline (fake CLI at the subprocess boundary)', () => {
  it('checks, builds, deploys, parses the URL, and records it in .studio/meta.json', async () => {
    const dir = makeProjectDir()
    fs.writeFileSync(path.join(dir, 'vercel.json'), '{}')
    writeStudioMeta(dir, { trust: 'run-project' })

    const { spawn, calls } = fakeCli({
      'vercel whoami': { stdout: 'studio-tester\n' },
      'vercel build': { stdout: 'Build Completed in .vercel/output\n' },
      'vercel deploy --prebuilt': { stderr: VERCEL_DEPLOY_OUTPUT },
    })

    const id = await startDeployJob(dir, 'vercel', { spawn })
    const job = await waitForJob(id, dir)

    expect(job.status).toBe('succeeded')
    expect(job.url).toBe('https://preview-fixture-8kqvj2s1-studio.vercel.app')
    expect(job.phase).toBe('finished')
    expect(job.log).toContain('Build Completed')
    expect(job.log).toContain('vercel deploy --prebuilt')

    // The exact command set, in order — and no production deploy anywhere in it.
    expect(calls).toEqual([['vercel', 'whoami'], ['vercel', 'build'], ['vercel', 'deploy', '--prebuilt']])
    expect(calls.flat()).not.toContain('--prod')

    const persisted = readStudioMeta(dir).lastDeploy
    expect(persisted?.id).toBe(id)
    expect(persisted?.status).toBe('succeeded')
    expect(persisted?.url).toBe('https://preview-fixture-8kqvj2s1-studio.vercel.app')
    expect(persisted?.provider).toBe('vercel')
  })

  it('stops before the build when nobody is signed in, and says which command fixes it', async () => {
    const dir = makeProjectDir()
    writeStudioMeta(dir, { trust: 'run-project' })

    const { spawn, calls } = fakeCli({
      'netlify status': { stdout: 'You are not currently logged in.\n' },
    })

    const job = await waitForJob(await startDeployJob(dir, 'netlify', { spawn }), dir)
    expect(job.status).toBe('failed')
    expect(job.message).toContain('netlify login')
    // The build never ran — that is the point of probing first.
    expect(calls).toEqual([['netlify', 'status']])
  })

  it('fails at the build without deploying anything', async () => {
    const dir = makeProjectDir()
    writeStudioMeta(dir, { trust: 'run-project' })

    const { spawn, calls } = fakeCli({
      'vercel whoami': { stdout: 'studio-tester\n' },
      'vercel build': { stderr: 'Error: Command "vite build" exited with 1\n', code: 1 },
    })

    const job = await waitForJob(await startDeployJob(dir, 'vercel', { spawn }), dir)
    expect(job.status).toBe('failed')
    expect(job.url).toBeNull()
    expect(job.message).toContain('build failed')
    expect(calls.map((argv) => argv[1])).toEqual(['whoami', 'build'])
  })

  it('reports success honestly when the CLI printed no URL it could read', async () => {
    const dir = makeProjectDir()
    writeStudioMeta(dir, { trust: 'run-project' })

    const { spawn } = fakeCli({
      'netlify status': { stdout: NETLIFY_STATUS_OUTPUT },
      'netlify build': { stdout: 'Netlify Build complete\n' },
      'netlify deploy': { stdout: 'Deploy is live!\n' },
    })

    const job = await waitForJob(await startDeployJob(dir, 'netlify', { spawn }), dir)
    expect(job.status).toBe('succeeded')
    expect(job.url).toBeNull()
    expect(job.message).toContain('did not print a preview URL')
  })
})
