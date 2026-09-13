/**
 * devServer — the process manager extracted out of `server/ai/mcp/tools/
 * studio/referenceRender.ts` (Track L, `live-01`).
 *
 * No real subprocess is ever spawned here — `spawn` is always injected
 * (`DevServerOverrides`), the same seam `installDeps.test.ts`/
 * `deploy.test.ts` use for their fake processes/CLIs. `bootTimeoutMs` is set
 * to a few milliseconds in the timeout case so it never waits wall-clock time.
 *
 * Split, same as `deploy.test.ts`, into: primitive-level tests (boot
 * mechanics, reuse, teardown — exercised through `ensureDevServer`/
 * `startDevServer`/`getDevServerStatus`/`stopDevServer` directly with a fake
 * spawn) and route-level tests (the Tier-2 trust gate — the security
 * control, so tested through `tryServeStudioDevServer` itself, not just the
 * function it protects). `tryServeStudioDevServer`'s test-only fourth
 * argument lets the "gate passes, dev server actually starts" case run
 * through one real HTTP call too, per the work order's explicit "Done when"
 * criterion.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ensureDevServer,
  getDevServerStatus,
  startDevServer,
  stopDevServer,
  tryServeStudioDevServer,
  type DevServerOverrides,
} from '../devServer'
import { writeStudioMeta } from '../studioMeta'
import type { SpawnedProcessLike } from '../subprocessRunner'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    },
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Never closes — simulates a dev server that keeps running (no EOF)
      // without ever printing a URL, so `pumpAndWatch` never resolves the
      // stream side; the boot-timeout race is what settles the test.
    },
  })
}

interface FakeProcessOptions {
  stdoutChunks?: string[]
  hangUntilKilled?: boolean
}

function makeFakeProcess(opts: FakeProcessOptions = {}): { proc: SpawnedProcessLike; wasKilled: () => boolean } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExited = resolve })
  if (!opts.hangUntilKilled) resolveExited(0)

  const proc: SpawnedProcessLike = {
    stdout: opts.stdoutChunks ? streamFromChunks(opts.stdoutChunks) : emptyStream(),
    stderr: emptyStream(),
    exited,
    pid: 4242,
    kill: () => {
      killed = true
      resolveExited(-1)
    },
  }
  return { proc, wasKilled: () => killed }
}

function writePackageJson(dir: string, scripts: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
}

function makeTmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

async function waitUntil(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('condition never became true')
}

// ---------------------------------------------------------------------------
// ensureDevServer — the blocking primitive `referenceRender.ts` consumes
// ---------------------------------------------------------------------------

describe('ensureDevServer', () => {
  it('boots the dev server and discovers its printed URL', async () => {
    const tmpDir = makeTmpDir('studio-devserver-boot-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const { proc } = makeFakeProcess({ stdoutChunks: ['  VITE v5.0.0  ready\n', '  ➜  Local:   http://localhost:5173/\n'] })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc })

    expect(result.ok).toBe(true)
    expect(result.ok && result.baseUrl).toBe('http://localhost:5173')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('strips ANSI escape codes wrapped around the port before matching the URL — confirmed-necessary Vite v8 regression', async () => {
    const tmpDir = makeTmpDir('studio-devserver-ansi-')
    writePackageJson(tmpDir, { dev: 'vite' })
    // Vite v8 colorizes just the port digits: the ':' and the digits are
    // split by an escape sequence. Without stripping first, URL_PATTERN's
    // `:\d+` never matches.
    const { proc } = makeFakeProcess({
      stdoutChunks: ['  ➜  Local:   http://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'],
    })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc })

    expect(result.ok).toBe(true)
    expect(result.ok && result.baseUrl).toBe('http://localhost:5173')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ok:false with the captured log when the dev server never prints a URL (boot timeout)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-timeout-')
    writePackageJson(tmpDir, { dev: 'some-slow-thing' })
    const { proc, wasKilled } = makeFakeProcess({ hangUntilKilled: true })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc, bootTimeoutMs: 15 })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.length > 0).toBe(true)
    expect(wasKilled()).toBe(true)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ok:false with a clear message when package.json has no dev or start script', async () => {
    const tmpDir = makeTmpDir('studio-devserver-noscript-')
    writePackageJson(tmpDir, { build: 'vite build' })

    const result = await ensureDevServer(tmpDir, { spawn: () => makeFakeProcess().proc })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('dev')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reuses the same dev server across calls for the same project (no second spawn)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-reuse-')
    writePackageJson(tmpDir, { dev: 'vite' })
    let spawnCount = 0
    const overrides: DevServerOverrides = {
      spawn: () => {
        spawnCount += 1
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5174/\n'] }).proc
      },
    }

    await ensureDevServer(tmpDir, overrides)
    await ensureDevServer(tmpDir, overrides)

    expect(spawnCount).toBe(1)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// The non-blocking primitives — status/start/stop
// ---------------------------------------------------------------------------

describe('getDevServerStatus / startDevServer / stopDevServer', () => {
  it('reports stopped for a project with no entry', () => {
    const tmpDir = makeTmpDir('studio-devserver-stopped-')
    expect(getDevServerStatus(tmpDir)).toEqual({ phase: 'stopped', pid: null, startedAt: null, log: '' })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('start returns immediately without waiting for boot, then status observes the ready transition', async () => {
    const tmpDir = makeTmpDir('studio-devserver-start-')
    writePackageJson(tmpDir, { dev: 'vite' })
    let spawnCount = 0
    const overrides: DevServerOverrides = {
      spawn: () => {
        spawnCount += 1
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5175/\n'] }).proc
      },
    }

    const started = startDevServer(tmpDir, overrides)
    expect(started.phase === 'booting' || started.phase === 'ready').toBe(true)
    expect(spawnCount).toBe(1)

    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'ready')
    // A second start while already ready must not spawn again.
    startDevServer(tmpDir, overrides)
    expect(spawnCount).toBe(1)

    stopDevServer(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retains a failed boot in the registry so status can show its log, then clears it on the next start', async () => {
    const tmpDir = makeTmpDir('studio-devserver-failed-')
    writePackageJson(tmpDir, { dev: 'some-slow-thing' })
    let spawnCount = 0
    const overrides: DevServerOverrides = {
      spawn: () => {
        spawnCount += 1
        return makeFakeProcess({ hangUntilKilled: true }).proc
      },
      bootTimeoutMs: 10,
    }

    startDevServer(tmpDir, overrides)
    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'failed')
    expect(getDevServerStatus(tmpDir).log).toBeDefined()

    // Next start attempt clears the failed entry and spawns fresh.
    startDevServer(tmpDir, overrides)
    expect(spawnCount).toBe(2)

    stopDevServer(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stop kills a running process and resets status to stopped; stopping twice is a no-op', async () => {
    const tmpDir = makeTmpDir('studio-devserver-stop-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const { proc, wasKilled } = makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5176/\n'] })

    startDevServer(tmpDir, { spawn: () => proc })
    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'ready')

    expect(stopDevServer(tmpDir)).toEqual({ phase: 'stopped', pid: null, startedAt: null, log: '' })
    expect(wasKilled()).toBe(true)
    expect(getDevServerStatus(tmpDir)).toEqual({ phase: 'stopped', pid: null, startedAt: null, log: '' })
    // Idempotent.
    expect(stopDevServer(tmpDir)).toEqual({ phase: 'stopped', pid: null, startedAt: null, log: '' })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// tryServeStudioDevServer — the trust gate, tested through the route
// ---------------------------------------------------------------------------

function call(pathAndQuery: string, init?: RequestInit, overrides?: DevServerOverrides): Promise<Response | null> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return tryServeStudioDevServer(new Request(url, init), url, url.pathname, overrides)
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('tryServeStudioDevServer', () => {
  it('does not claim routes it does not own', async () => {
    const res = await call('/admin/api/studio/deploy/status')
    expect(res).toBeNull()
  })

  it('refuses GET status at Tier 0 (static, the default) with 409 trust-tier-required', async () => {
    const tmpDir = makeTmpDir('studio-devserver-route-status-refuse-')
    fs.mkdirSync(tmpDir, { recursive: true })

    const res = await call(`/admin/api/studio/dev-server/status?dir=${encodeURIComponent(tmpDir)}`)

    expect(res?.status).toBe(409)
    const body = (await res!.json()) as { code: string; error: string }
    expect(body.code).toBe('trust-tier-required')
    expect(body.error).toContain('run-project')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses POST start at Tier 1 (render-packages) too — never touches the spawner', async () => {
    const tmpDir = makeTmpDir('studio-devserver-route-start-refuse-')
    fs.mkdirSync(tmpDir, { recursive: true })
    writeStudioMeta(tmpDir, { trust: 'render-packages' })
    let spawned = false

    const res = await call(
      '/admin/api/studio/dev-server/start',
      post({ dir: tmpDir }),
      { spawn: () => { spawned = true; return makeFakeProcess().proc } },
    )

    expect(res?.status).toBe(409)
    expect(spawned).toBe(false)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('at Tier 2, POST start returns booting and GET status observes ready against a fake dev server', async () => {
    const tmpDir = makeTmpDir('studio-devserver-route-ready-')
    writePackageJson(tmpDir, { dev: 'vite' })
    writeStudioMeta(tmpDir, { trust: 'run-project' })

    const startRes = await call(
      '/admin/api/studio/dev-server/start',
      post({ dir: tmpDir }),
      { spawn: () => makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5177/\n'] }).proc },
    )
    expect(startRes?.status).toBe(200)
    const startBody = (await startRes!.json()) as { phase: string }
    expect(['booting', 'ready']).toContain(startBody.phase)

    let statusBody: { phase: string } = { phase: '' }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await call(`/admin/api/studio/dev-server/status?dir=${encodeURIComponent(tmpDir)}`)
      statusBody = (await res!.json()) as { phase: string }
      if (statusBody.phase === 'ready') break
      await Bun.sleep(5)
    }
    expect(statusBody.phase).toBe('ready')

    // stop is ungated — still Tier 2 here, but confirm it never checks trust.
    const stopRes = await call('/admin/api/studio/dev-server/stop', post({ dir: tmpDir }))
    expect(stopRes?.status).toBe(200)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POST stop is never gated — works even at Tier 0', async () => {
    const tmpDir = makeTmpDir('studio-devserver-route-stop-ungated-')
    fs.mkdirSync(tmpDir, { recursive: true })

    const res = await call('/admin/api/studio/dev-server/stop', post({ dir: tmpDir }))

    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { phase: string }
    expect(body.phase).toBe('stopped')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
