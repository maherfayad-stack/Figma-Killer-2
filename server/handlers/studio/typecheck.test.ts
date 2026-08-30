/**
 * typecheck.ts — `runProjectTypecheck`/`resolveProjectTscPath` coverage.
 * Every subprocess here is a FAKE (`SpawnedProcessLike` injected via
 * `overrides.spawn`) and every timer injected — no real `tsc` execution, no
 * real wall-clock wait, matching `subprocessRunner.test.ts`'s own discipline.
 * A dummy `node_modules/typescript/bin/tsc` FILE still has to exist on disk
 * for each "installed" fixture, because `resolveProjectTscPath`'s
 * `existsSync` + containment check runs for real — only the actual process
 * spawn is faked.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveProjectTscPath, runProjectTypecheck, type TypecheckOverrides } from './typecheck'
import type { SpawnedProcessLike, SubprocessSpawnFn } from './subprocessRunner'

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-typecheck-'))
}

function installFakeTsc(root: string): void {
  // Content is irrelevant — every test here fakes the actual spawn, this
  // file only has to exist so resolveProjectTscPath's existsSync check
  // (correctly) finds it.
  write(root, 'node_modules/typescript/bin/tsc', '#!/usr/bin/env node\n')
}

interface FakeProcessOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
  hangUntilKilled?: boolean
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
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

function makeImmediateTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout } {
  const setTimeoutImpl = ((handler: () => void) => {
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const clearTimeoutImpl = (() => {}) as typeof clearTimeout
  return { setTimeoutImpl, clearTimeoutImpl }
}

describe('resolveProjectTscPath', () => {
  it('returns undefined when node_modules/typescript is not installed', () => {
    const dir = makeTmpProject()
    expect(resolveProjectTscPath(dir)).toBeUndefined()
  })

  it('returns the bin/tsc path when installed', () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    expect(resolveProjectTscPath(dir)).toBe(path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'))
  })
})

describe('runProjectTypecheck — not-available cases', () => {
  it('reports no-tsconfig when the project has no tsconfig.json, even with typescript installed', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    const result = await runProjectTypecheck(dir)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ available: false, reason: 'no-tsconfig' })
  })

  it('reports typescript-not-installed when tsconfig.json exists but node_modules/typescript does not', async () => {
    const dir = makeTmpProject()
    write(dir, 'tsconfig.json', '{}')
    const result = await runProjectTypecheck(dir)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ available: false, reason: 'typescript-not-installed' })
  })
})

describe('runProjectTypecheck — a real (faked) tsc run', () => {
  function spawnReturning(opts: FakeProcessOptions): SubprocessSpawnFn {
    return () => makeFakeProcess(opts).proc
  }

  it('passes cleanly on exit 0 with no diagnostics', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    write(dir, 'tsconfig.json', '{}')

    const result = await runProjectTypecheck(dir, { spawn: spawnReturning({ stdout: '', exitCode: 0 }) })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('parses diagnostics from a failing run', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    write(dir, 'tsconfig.json', '{}')

    const stdout = "src/screens/Home.tsx(2,3): error TS2322: Type 'string' is not assignable to type 'number'.\n"
    const result = await runProjectTypecheck(dir, { spawn: spawnReturning({ stdout, exitCode: 2 }) })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ file: 'src/screens/Home.tsx', line: 2, column: 3, code: 'TS2322' })
  })

  it('passes the argv, cwd, and a minimal env — never a shell string, never process.env forwarded wholesale', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    write(dir, 'tsconfig.json', '{}')

    let capturedArgv: string[] = []
    let capturedOptions: { cwd: string; env: Record<string, string> } | undefined
    const spawn: SubprocessSpawnFn = (argv, options) => {
      capturedArgv = argv
      capturedOptions = options
      return makeFakeProcess({ exitCode: 0 }).proc
    }

    await runProjectTypecheck(dir, { spawn })

    expect(capturedArgv).toEqual([process.execPath, path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false', '--incremental', 'false'])
    expect(capturedOptions?.cwd).toBe(dir)
    expect(capturedOptions?.env.STUDIO_SECRET_KEY).toBeUndefined()
    expect(capturedOptions?.env.DATABASE_URL).toBeUndefined()
  })

  it('reports tsc-invocation-error on a non-zero exit with no parseable diagnostics — a broken toolchain, not a code error', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    write(dir, 'tsconfig.json', '{}')

    const result = await runProjectTypecheck(dir, { spawn: spawnReturning({ stdout: 'some fatal crash text', stderr: '', exitCode: 1 }) })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'tsc-invocation-error', exitCode: 1 })
  })

  it('returns a structured timeout result carrying whatever partial diagnostics tsc had already printed — no exception, no real wait', async () => {
    const dir = makeTmpProject()
    installFakeTsc(dir)
    write(dir, 'tsconfig.json', '{}')

    const partialStdout = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
    const { proc, wasKilled } = makeFakeProcess({ stdout: partialStdout, hangUntilKilled: true })
    const timer = makeImmediateTimer()
    const overrides: TypecheckOverrides = { spawn: () => proc, ...timer }

    const result = await runProjectTypecheck(dir, overrides)
    expect(wasKilled()).toBe(true)
    expect(result.ok).toBe(false)
    if (result.ok || !('timedOut' in result) || !result.timedOut) throw new Error('expected a timeout result')
    expect(result.partialDiagnostics).toHaveLength(1)
    expect(result.partialDiagnostics[0].code).toBe('TS2322')
  })
})
