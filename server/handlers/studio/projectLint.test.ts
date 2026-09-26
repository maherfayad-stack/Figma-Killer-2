/**
 * `runProjectLint` — the engine behind `studio_lint` (AI-21). Every process
 * here is a FAKE injected through the `spawn` seam, so these tests pin what
 * Studio HANDS the process (argv, cwd, env) and how it reads the answer, not
 * ESLint's own behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findProjectEslintConfig, runProjectLint } from './projectLint'
import { resolveProjectPackageBin } from './projectPackageBin'
import type { SpawnedProcessLike, SubprocessSpawnFn } from './subprocessRunner'

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function installFakeEslint(root: string): string {
  write(root, 'node_modules/eslint/package.json', JSON.stringify({ name: 'eslint', bin: { eslint: './bin/eslint.js' } }))
  write(root, 'node_modules/eslint/bin/eslint.js', '#!/usr/bin/env node\n')
  return path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js')
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

interface SpawnCall {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

function fakeSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean }): { spawn: SubprocessSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: SubprocessSpawnFn = (argv, options) => {
    calls.push({ argv, cwd: options.cwd, env: options.env })
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    if (!opts.hang) resolveExit(opts.exitCode ?? 0)
    const proc: SpawnedProcessLike = {
      stdout: stream(opts.stdout ?? ''),
      stderr: stream(opts.stderr ?? ''),
      exited,
      kill: () => resolveExit(-1),
    }
    return proc
  }
  return { spawn, calls }
}

function eslintReport(dir: string): string {
  return JSON.stringify([
    {
      filePath: path.join(dir, 'pages', 'Home.tsx'),
      messages: [
        { ruleId: 'react-hooks/rules-of-hooks', severity: 2, message: 'Hook called conditionally.', line: 4, column: 3 },
        { ruleId: 'no-unused-vars', severity: 1, message: "'x' is unused.", line: 9, column: 7 },
      ],
      errorCount: 1,
      warningCount: 1,
      source: 'export default function Home() {}',
    },
  ])
}

describe('runProjectLint', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lint-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses eslint-not-installed without spawning when the project has no eslint of its own', async () => {
    write(dir, 'eslint.config.js', 'export default []\n')
    const { spawn, calls } = fakeSpawn({})
    const result = await runProjectLint(dir, dir, [], { spawn, runtime: 'node' })
    expect(result).toMatchObject({ ok: false, code: 'eslint-not-installed' })
    expect(calls).toHaveLength(0)
  })

  it('refuses no-eslint-config when the only config is ABOVE the project, never borrowing it', async () => {
    // A project under studio-workspace/ sits inside Studio's own repository,
    // whose eslint.config.js flat-config lookup would otherwise find.
    const project = path.join(dir, 'workspace', 'app')
    fs.mkdirSync(project, { recursive: true })
    write(dir, 'eslint.config.js', 'export default []\n')
    installFakeEslint(project)
    const { spawn, calls } = fakeSpawn({})
    const result = await runProjectLint(project, project, [], { spawn, runtime: 'node' })
    expect(result).toMatchObject({ ok: false, code: 'no-eslint-config' })
    expect(calls).toHaveLength(0)
  })

  it('runs the project\'s own eslint bin directly, pins the config, and never passes a writing flag', async () => {
    const bin = installFakeEslint(dir)
    write(dir, 'eslint.config.js', 'export default []\n')
    const { spawn, calls } = fakeSpawn({ stdout: eslintReport(dir), exitCode: 1 })
    const target = path.join(dir, 'pages', 'Home.tsx')
    const previousKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak'
    try {
      const result = await runProjectLint(dir, dir, [target], { spawn, runtime: 'node' })
      expect(result.ok).toBe(true)
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousKey
    }
    expect(calls).toHaveLength(1)
    const { argv, cwd, env } = calls[0]!
    expect(argv[0]).toBe('node')
    expect(argv[1]).toBe(bin)
    expect(argv).toContain('--format')
    expect(argv[argv.indexOf('--config') + 1]).toBe(path.join(dir, 'eslint.config.js'))
    expect(argv.at(-1)).toBe(target)
    for (const flag of ['--fix', '--fix-dry-run', '--cache', '--output-file', '-o']) expect(argv).not.toContain(flag)
    // No package manager, no npx: nothing that could run a prelint script or fetch a package.
    for (const token of ['npm', 'npx', 'pnpm', 'yarn', 'bunx', 'run']) expect(argv).not.toContain(token)
    expect(cwd).toBe(dir)
    expect(Object.values(env)).not.toContain('sk-must-not-leak')
  })

  it('maps the report to project-relative diagnostics', async () => {
    installFakeEslint(dir)
    write(dir, 'eslint.config.js', 'export default []\n')
    const { spawn } = fakeSpawn({ stdout: eslintReport(dir), exitCode: 1 })
    const result = await runProjectLint(dir, dir, [], { spawn, runtime: 'node' })
    if (!result.ok) throw new Error(`expected a report, got ${result.code}`)
    expect(result.configFile).toBe('eslint.config.js')
    expect(result.diagnostics).toEqual([
      { file: 'pages/Home.tsx', line: 4, column: 3, severity: 'error', ruleId: 'react-hooks/rules-of-hooks', message: 'Hook called conditionally.' },
      { file: 'pages/Home.tsx', line: 9, column: 7, severity: 'warning', ruleId: 'no-unused-vars', message: "'x' is unused." },
    ])
  })

  it('reads ESLint\'s own exit 2 as a broken setup, never as a clean pass', async () => {
    installFakeEslint(dir)
    write(dir, 'eslint.config.js', 'export default []\n')
    const { spawn } = fakeSpawn({ stdout: '', stderr: 'Error: Cannot find package eslint-plugin-foo', exitCode: 2 })
    const result = await runProjectLint(dir, dir, [], { spawn, runtime: 'node' })
    expect(result).toMatchObject({ ok: false, code: 'lint-invocation-error', exitCode: 2 })
    if (!result.ok && result.code === 'lint-invocation-error') expect(result.outputExcerpt).toContain('eslint-plugin-foo')
  })

  it('reports lint-timed-out when the run is killed', async () => {
    installFakeEslint(dir)
    write(dir, 'eslint.config.js', 'export default []\n')
    const { spawn } = fakeSpawn({ hang: true })
    const setTimeoutImpl = ((handler: () => void) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const result = await runProjectLint(dir, dir, [], { spawn, runtime: 'node', setTimeoutImpl, clearTimeoutImpl: (() => {}) as typeof clearTimeout })
    expect(result).toMatchObject({ ok: false, code: 'lint-timed-out' })
  })

  it('finds a legacy .eslintrc and a package.json eslintConfig, flat config first', () => {
    write(dir, '.eslintrc.json', '{}')
    expect(findProjectEslintConfig(dir, dir)).toEqual({ file: path.join(dir, '.eslintrc.json'), kind: 'legacy-file' })
    write(dir, 'eslint.config.mjs', 'export default []\n')
    expect(findProjectEslintConfig(dir, dir)).toEqual({ file: path.join(dir, 'eslint.config.mjs'), kind: 'flat' })
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lint-pkg-'))
    try {
      write(other, 'package.json', JSON.stringify({ eslintConfig: { rules: {} } }))
      expect(findProjectEslintConfig(other, other)).toEqual({ file: path.join(other, 'package.json'), kind: 'legacy-package' })
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('resolveProjectPackageBin', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-bin-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('finds a bin hoisted to the project root from a nested app root, and never above the project', () => {
    const app = path.join(dir, 'apps', 'web')
    fs.mkdirSync(app, { recursive: true })
    const bin = installFakeEslint(dir)
    expect(resolveProjectPackageBin(app, dir, 'eslint', 'eslint')).toBe(bin)
    // The same install one level ABOVE the project does not count.
    expect(resolveProjectPackageBin(app, app, 'eslint', 'eslint')).toBeNull()
  })

  it('refuses a bin path that leaves the project', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-bin-outside-'))
    try {
      write(elsewhere, 'outside.js', '')
      write(dir, 'node_modules/eslint/package.json', JSON.stringify({ bin: { eslint: path.join(elsewhere, 'outside.js') } }))
      expect(resolveProjectPackageBin(dir, dir, 'eslint', 'eslint')).toBeNull()
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
