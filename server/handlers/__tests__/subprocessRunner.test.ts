/**
 * subprocessRunner.ts — unit coverage for the shared spawn+timeout+capped-
 * capture primitive `sec-01` extracted out of `installDeps.ts`/`styleCompile.ts`.
 * Every spawn here is a fake (`SpawnedProcessLike`) and every timer is
 * injected — no real subprocess, no real wall-clock wait, matching
 * `installDeps.test.ts`'s own discipline.
 */
import { describe, expect, it } from 'bun:test'
import { captureSubprocess, minimalSubprocessEnv, runCappedSubprocess, type SpawnedProcessLike, type SubprocessSpawnFn } from '../studio/subprocessRunner'

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

interface FakeProcessOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
  hangUntilKilled?: boolean
}

function makeFakeProcess(opts: FakeProcessOptions = {}): { proc: SpawnedProcessLike; wasKilled: () => boolean } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  if (!opts.hangUntilKilled) resolveExited(opts.exitCode ?? 0)

  const proc: SpawnedProcessLike = {
    stdout: streamFromString(opts.stdout ?? ''),
    stderr: streamFromString(opts.stderr ?? ''),
    exited,
    kill: () => {
      killed = true
      resolveExited(opts.exitCode ?? -1)
    },
  }
  return { proc, wasKilled: () => killed }
}

function makeImmediateTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout; delays: number[] } {
  const delays: number[] = []
  const setTimeoutImpl = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const clearTimeoutImpl = (() => {}) as typeof clearTimeout
  return { setTimeoutImpl, clearTimeoutImpl, delays }
}

function makeInertTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout } {
  const setTimeoutImpl = (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout
  const clearTimeoutImpl = (() => {}) as typeof clearTimeout
  return { setTimeoutImpl, clearTimeoutImpl }
}

describe('captureSubprocess', () => {
  it('returns stdout/stderr and exit code for a well-behaved process', async () => {
    const { proc } = makeFakeProcess({ stdout: 'hello', stderr: '', exitCode: 0 })
    const timer = makeInertTimer()
    const result = await captureSubprocess(proc, { timeoutMs: 1000, maxStdoutBytes: 1000, maxStderrBytes: 1000, ...timer })

    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutTruncated).toBe(false)
  })

  it('caps stdout independently of stderr and marks each truncated flag separately', async () => {
    const { proc } = makeFakeProcess({ stdout: 'x'.repeat(500), stderr: 'y'.repeat(10), exitCode: 0 })
    const timer = makeInertTimer()
    const result = await captureSubprocess(proc, { timeoutMs: 1000, maxStdoutBytes: 50, maxStderrBytes: 1000, ...timer })

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(false)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(500)
    expect(result.stdout).toContain('truncated')
    expect(result.stderr).toBe('y'.repeat(10))
  })

  it('times out, kills the process, and reports timedOut — no real wait', async () => {
    const { proc, wasKilled } = makeFakeProcess({ hangUntilKilled: true })
    const { setTimeoutImpl, clearTimeoutImpl, delays } = makeImmediateTimer()
    const result = await captureSubprocess(proc, {
      timeoutMs: 20_000,
      maxStdoutBytes: 1000,
      maxStderrBytes: 1000,
      setTimeoutImpl,
      clearTimeoutImpl,
    })

    expect(delays).toEqual([20_000])
    expect(wasKilled()).toBe(true)
    expect(result.timedOut).toBe(true)
  })
})

describe('runCappedSubprocess', () => {
  it('spawns with the given argv, cwd, and env — no shell string, no argv/env inherited implicitly', async () => {
    const calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = []
    const spawn: SubprocessSpawnFn = (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd, env: options.env })
      return makeFakeProcess({ stdout: 'ok', exitCode: 0 }).proc
    }
    const timer = makeInertTimer()

    await runCappedSubprocess(['bun', '/some/worker.ts', '{"kind":"sass"}'], {
      cwd: '/workspace/project',
      env: { PATH: '/usr/bin' },
      timeoutMs: 1000,
      maxStdoutBytes: 1000,
      maxStderrBytes: 1000,
      spawn,
      ...timer,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['bun', '/some/worker.ts', '{"kind":"sass"}'])
    expect(calls[0]!.cwd).toBe('/workspace/project')
    expect(calls[0]!.env).toEqual({ PATH: '/usr/bin' })
  })
})

describe('minimalSubprocessEnv', () => {
  it('never forwards a secret-shaped env var that is not on its explicit allowlist', () => {
    const original = process.env.STUDIO_SECRET_KEY
    const originalDb = process.env.DATABASE_URL
    process.env.STUDIO_SECRET_KEY = 'top-secret-test-value'
    process.env.DATABASE_URL = 'postgres://leak-me'
    try {
      const env = minimalSubprocessEnv()
      expect(env.STUDIO_SECRET_KEY).toBeUndefined()
      expect(env.DATABASE_URL).toBeUndefined()
      expect(Object.values(env)).not.toContain('top-secret-test-value')
      expect(Object.values(env)).not.toContain('postgres://leak-me')
    } finally {
      if (original === undefined) delete process.env.STUDIO_SECRET_KEY
      else process.env.STUDIO_SECRET_KEY = original
      if (originalDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDb
    }
  })

  it('forwards only the requested extra keys, not the whole environment', () => {
    const original = process.env.SOME_RANDOM_TEST_VAR
    process.env.SOME_RANDOM_TEST_VAR = 'should-not-leak'
    try {
      const env = minimalSubprocessEnv(['APPDATA'])
      expect(env.SOME_RANDOM_TEST_VAR).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.SOME_RANDOM_TEST_VAR
      else process.env.SOME_RANDOM_TEST_VAR = original
    }
  })
})
