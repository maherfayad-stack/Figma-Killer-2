/**
 * studio_render_reference — unit tests for the Tier 2 dev-server + Playwright
 * reference render.
 *
 * No real subprocess and no real browser are ever spawned here — `spawn` and
 * `launchBrowser` are always injected (`ReferenceRenderOverrides`), same
 * pattern `installDeps.test.ts` uses for its fake process. `bootTimeoutMs` is
 * set to a few milliseconds in the timeout test so it never waits wall-clock
 * time either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createReferenceRenderTool,
  type PlaywrightLikeBrowser,
  type PlaywrightLikePage,
  type ReferenceRenderOverrides,
} from './referenceRender'
import type { SpawnedProcessLike } from '../../../../handlers/studio/subprocessRunner'
import { stopDevServer } from '../../../../handlers/studio/devServer'
import { STUDIO_DEV_SERVER_STATE_DIR_ENV } from '../../../../handlers/studio/devServerRecords'

// `live-11` — a dev server that reaches `'ready'` writes a record into
// `STUDIO_DEV_SERVER_STATE_DIR`; without this the fakes below would leave
// records in the repo's real `.tmp/dev-servers/`.
let stateDir: string
let previousStateDir: string | undefined
/** Every project dir a test booted — stopped after it so no registry entry, idle timer or log tail outlives the test. */
const bootedDirs: string[] = []

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-reference-state-')))
  previousStateDir = process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV]
  process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV] = stateDir
})

afterEach(() => {
  for (const dir of bootedDirs.splice(0)) stopDevServer(dir)
  if (previousStateDir === undefined) delete process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV]
  else process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV] = previousStateDir
  fs.rmSync(stateDir, { recursive: true, force: true })
})

interface FakeProcessOptions {
  stdoutChunks?: string[]
}

/**
 * A fake dev-server process. Like a real one it stays alive until it is
 * killed. Its output is NOT a stream: since `live-16` a real child writes to
 * the log FILE the manager hands every spawn (`options.logPath`), and
 * `devServer.ts` tails that file for the "Local:" URL. A fake that only
 * filled `stdout` was never read, so every boot ran into the 30 s boot race
 * and the test timed out. `stdoutChunks` are written to that file; omitting
 * them models a server that keeps running without ever printing a URL.
 */
function makeFakeProcess(opts: FakeProcessOptions = {}): { spawn: NonNullable<ReferenceRenderOverrides['spawn']>; wasKilled: () => boolean } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExited = resolve })

  const proc: SpawnedProcessLike = {
    stdout: null,
    stderr: null,
    exited,
    kill: () => {
      killed = true
      resolveExited(-1)
    },
  }
  const spawn: NonNullable<ReferenceRenderOverrides['spawn']> = (_argv, options) => {
    fs.writeFileSync(options.logPath, (opts.stdoutChunks ?? []).join(''), 'utf8')
    return proc
  }
  return { spawn, wasKilled: () => killed }
}

function makeFakeBrowser(pngBase64: string): { browser: PlaywrightLikeBrowser; gotoUrls: string[]; closed: () => boolean } {
  const gotoUrls: string[] = []
  let closed = false
  const page: PlaywrightLikePage = {
    goto: async (url) => { gotoUrls.push(url) },
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from(pngBase64, 'base64'),
    close: async () => {},
  }
  const browser: PlaywrightLikeBrowser = {
    newPage: async () => page,
    close: async () => { closed = true },
  }
  return { browser, gotoUrls, closed: () => closed }
}

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function writePackageJson(dir: string, scripts: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
}

/**
 * A10 — every non-refusal path below needs the project at Tier 2, because
 * the tool now checks the PROJECT's own trust tier in addition to the
 * connector capability (`sec-05` finding 1). Written as a real
 * `.studio/meta.json` rather than a mock so the test exercises the same
 * `readStudioMeta` path the HTTP route does.
 */
function writeTrustTier(dir: string, trust: 'static' | 'render-packages' | 'run-project'): void {
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.studio', 'meta.json'), JSON.stringify({ trust }))
}

describe('studio_render_reference', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-reference-')))
    bootedDirs.push(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('boots the dev server, discovers its printed URL, and screenshots the route', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'run-project')
    const { spawn } = makeFakeProcess({ stdoutChunks: ['  VITE v5.0.0  ready\n', '  ➜  Local:   http://localhost:5173/\n'] })
    const { browser, gotoUrls } = makeFakeBrowser(TINY_PNG_BASE64)

    const overrides: ReferenceRenderOverrides = {
      spawn,
      launchBrowser: async () => browser,
    }
    const tool = createReferenceRenderTool(overrides)
    const result = (await tool.handler!({ dir: tmpDir, route: '/?page=homepage', width: 390, height: 844 }, {} as never)) as {
      ok: boolean
      data?: { url: string; width: number; height: number }
      images?: Array<{ mimeType: string; data: string }>
    }

    expect(result.ok).toBe(true)
    expect(result.data!.url).toBe('http://127.0.0.1:5173/?page=homepage')
    expect(result.data!.width).toBe(390)
    expect(gotoUrls).toEqual(['http://127.0.0.1:5173/?page=homepage'])
    expect(result.images).toBeDefined()
    expect(result.images!.length).toBe(1)
    expect(result.images![0]!.mimeType).toBe('image/png')
  })

  it('returns ok:false with the captured log when the dev server never prints a URL (boot timeout)', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'run-project')
    const { spawn, wasKilled } = makeFakeProcess()

    const overrides: ReferenceRenderOverrides = {
      spawn,
      bootTimeoutMs: 15,
    }
    const tool = createReferenceRenderTool(overrides)
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as {
      ok: boolean
      error?: string
      code?: string
    }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('dev-server-failed-to-boot')
    expect(result.error).toBeDefined()
    expect(result.error!.length).toBeGreaterThan(0)
    expect(wasKilled()).toBe(true)
  })

  it('returns ok:false with a clear message when package.json has no dev or start script', async () => {
    writePackageJson(tmpDir, { build: 'vite build' })
    writeTrustTier(tmpDir, 'run-project')

    const tool = createReferenceRenderTool({ spawn: makeFakeProcess().spawn })
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('dev')
  })

  it('reuses the same dev server across calls for the same project (no second spawn)', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'run-project')
    let spawnCount = 0
    const overrides: ReferenceRenderOverrides = {
      spawn: (argv, options) => {
        spawnCount += 1
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5174/\n'] }).spawn(argv, options)
      },
      launchBrowser: async () => makeFakeBrowser(TINY_PNG_BASE64).browser,
    }
    const tool = createReferenceRenderTool(overrides)

    await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)
    await tool.handler!({ dir: tmpDir, route: '/about' }, {} as never)

    expect(spawnCount).toBe(1)
  })
})

/**
 * A10 — `sec-05` finding 1. The connector capability
 * (`requiredCapabilities: ['studio.run.project']`, enforced by
 * `toolAllowedForCapabilities` before the handler runs) says the CALLER may
 * run project code. It says nothing about the project being pointed at, so
 * on its own it let a connector boot a dev server for a project its owner
 * had never promoted — strictly weaker than the HTTP route doing the same
 * spawn. These assert the second, per-project gate: nothing is spawned below
 * Tier 2, and the refusal is the same structured `trust-tier-required` code
 * every other Tier-2 refusal uses.
 */
describe('studio_render_reference — the project\'s own trust tier', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-reference-trust-')))
    bootedDirs.push(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('still declares the connector capability — the tier check ADDS a gate, it does not replace one', () => {
    expect(createReferenceRenderTool().requiredCapabilities).toEqual(['studio.run.project'])
  })

  it('refuses a Tier 0 (static) project with trust-tier-required, and spawns nothing', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'static')
    let spawnCount = 0

    const tool = createReferenceRenderTool({
      spawn: (argv, options) => {
        spawnCount += 1
        return makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5173/\n'] }).spawn(argv, options)
      },
    })
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as {
      ok: boolean
      code?: string
      error?: string
      trust?: string
      requiredTrust?: string
    }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('trust-tier-required')
    expect(result.trust).toBe('static')
    expect(result.requiredTrust).toBe('run-project')
    // The message has to tell the agent what to do next, not just that it failed.
    expect(result.error).toContain('promote')
    expect(spawnCount).toBe(0)
  })

  it('refuses a Tier 1 (render-packages) project too — the gate is equality, not a floor', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'render-packages')

    const tool = createReferenceRenderTool({ spawn: makeFakeProcess().spawn })
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as { ok: boolean; code?: string; trust?: string }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('trust-tier-required')
    expect(result.trust).toBe('render-packages')
  })

  it('a project with no .studio/meta.json at all is at the default tier — run-project — and proceeds', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })

    const tool = createReferenceRenderTool({
      spawn: makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5198/\n'] }).spawn,
      launchBrowser: async () => makeFakeBrowser(TINY_PNG_BASE64).browser,
    })
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as { ok: boolean; code?: string }

    expect(result.ok).toBe(true)
    expect(result.code).toBeUndefined()
  })

  it('proceeds once the project is promoted to run-project', async () => {
    writePackageJson(tmpDir, { dev: 'vite' })
    writeTrustTier(tmpDir, 'run-project')

    const tool = createReferenceRenderTool({
      spawn: makeFakeProcess({ stdoutChunks: ['Local: http://localhost:5199/\n'] }).spawn,
      launchBrowser: async () => makeFakeBrowser(TINY_PNG_BASE64).browser,
    })
    const result = (await tool.handler!({ dir: tmpDir, route: '/' }, {} as never)) as { ok: boolean; code?: string }

    expect(result.ok).toBe(true)
    expect(result.code).toBeUndefined()
  })
})
