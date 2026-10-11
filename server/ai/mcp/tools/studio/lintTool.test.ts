/**
 * `studio_lint` — the tool's own contract (AI-21): both Tier-2 gates, path
 * containment before anything becomes an argument, and the response shape.
 * The engine's argv/env/exit-code handling is `projectLint.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStudioLintTool } from './lintTool'
import { selectStudioTools } from '../../../tools'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../../../handlers/studio/subprocessRunner'

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function lintableProject(dir: string, trust?: 'static' | 'render-packages' | 'run-project'): void {
  write(dir, 'package.json', JSON.stringify({ name: 'app' }))
  write(dir, 'node_modules/eslint/package.json', JSON.stringify({ bin: { eslint: 'bin/eslint.js' } }))
  write(dir, 'node_modules/eslint/bin/eslint.js', '')
  write(dir, 'eslint.config.js', 'export default []\n')
  if (trust) write(dir, '.studio/meta.json', JSON.stringify({ trust }))
}

function recordingSpawn(stdout: string, exitCode = 0): { spawn: SubprocessSpawnFn; argvs: string[][] } {
  const argvs: string[][] = []
  const spawn: SubprocessSpawnFn = (argv) => {
    argvs.push(argv)
    const body = new TextEncoder().encode(stdout)
    const proc: SpawnedProcessLike = {
      stdout: new ReadableStream({ start: (c) => { c.enqueue(body); c.close() } }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(exitCode),
      kill: () => {},
    }
    return proc
  }
  return { spawn, argvs }
}

type LintResult = {
  ok: boolean
  code?: string
  pass?: boolean
  errorCount?: number
  warningCount?: number
  truncated?: boolean
  diagnostics?: Array<{ file: string; severity: string }>
}

describe('studio_lint', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lint-tool-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('declares both halves of the Tier-2 gate and is an observer to the loop', () => {
    const tool = createStudioLintTool()
    expect(tool.requiresWrite).toBe(true)
    expect(tool.requiredCapabilities).toEqual(['studio.run.project'])
    expect(tool.sideEffects).toBe('none')
    expect(tool.execution).toBe('server')
  })

  it('is not offered to a caller without studio.run.project, on either agent path', () => {
    for (const fileAccess of ['native', 'studio-tools'] as const) {
      const offered = selectStudioTools(['ai.chat', 'ai.tools.write', 'studio.write'], { studioProjectOpen: true, fileAccess })
      expect(offered.map((t) => t.name)).not.toContain('studio_lint')
      const admin = selectStudioTools(['ai.chat', 'ai.tools.write', 'studio.write', 'studio.run.project'], { studioProjectOpen: true, fileAccess })
      expect(admin.map((t) => t.name)).toContain('studio_lint')
    }
  })

  for (const trust of ['static', 'render-packages'] as const) {
    it(`refuses trust-tier-required at "${trust}" trust and never starts ESLint`, async () => {
      lintableProject(dir, trust)
      const { spawn, argvs } = recordingSpawn('[]')
      const result = (await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir }, {} as never)) as LintResult
      expect(result).toMatchObject({ ok: false, code: 'trust-tier-required' })
      expect(argvs).toHaveLength(0)
    })
  }

  it('refuses a path outside the project before anything runs', async () => {
    lintableProject(dir, 'run-project')
    const { spawn, argvs } = recordingSpawn('[]')
    const result = (await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir, paths: ['../elsewhere'] }, {} as never)) as LintResult
    expect(result).toMatchObject({ ok: false, code: 'path-outside-project' })
    expect(argvs).toHaveLength(0)
  })

  it('refuses a credential file as a lint target', async () => {
    lintableProject(dir, 'run-project')
    write(dir, '.env', 'SECRET=1\n')
    const { spawn, argvs } = recordingSpawn('[]')
    const result = (await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir, paths: ['.env'] }, {} as never)) as LintResult
    expect(result).toMatchObject({ ok: false, code: 'protected-path' })
    expect(argvs).toHaveLength(0)
  })

  it('a flag-shaped path reaches ESLint only as a contained absolute path, never as a flag', async () => {
    lintableProject(dir, 'run-project')
    const { spawn, argvs } = recordingSpawn('[]')
    await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir, paths: ['--fix'] }, {} as never)
    expect(argvs).toHaveLength(1)
    expect(argvs[0]).not.toContain('--fix')
    expect(argvs[0]!.at(-1)).toBe(path.join(dir, '--fix'))
  })

  it('at run-project trust, returns errors first, counts both severities, and caps the list', async () => {
    lintableProject(dir, 'run-project')
    const messages = Array.from({ length: 70 }, (_, i) => ({ ruleId: 'r', severity: i === 69 ? 2 : 1, message: `m${i}`, line: i + 1, column: 1 }))
    const { spawn } = recordingSpawn(JSON.stringify([{ filePath: path.join(dir, 'pages', 'A.tsx'), messages }]), 1)
    const result = (await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir }, {} as never)) as LintResult
    expect(result).toMatchObject({ ok: true, pass: false, errorCount: 1, warningCount: 69, truncated: true })
    expect(result.diagnostics).toHaveLength(60)
    expect(result.diagnostics![0]).toMatchObject({ file: 'pages/A.tsx', severity: 'error' })
  })

  it('a report with warnings only passes', async () => {
    lintableProject(dir, 'run-project')
    const { spawn } = recordingSpawn(JSON.stringify([{ filePath: path.join(dir, 'A.tsx'), messages: [{ ruleId: 'r', severity: 1, message: 'w', line: 1, column: 1 }] }]))
    const result = (await createStudioLintTool({ spawn, runtime: 'node' }).handler!({ dir }, {} as never)) as LintResult
    expect(result).toMatchObject({ ok: true, pass: true, errorCount: 0, warningCount: 1 })
  })
})
