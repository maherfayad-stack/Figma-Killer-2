/**
 * `recordToolWrite.ts`/`stopGateCheck.ts` — genuinely SPAWNED as `[bun,
 * <script>]` subprocesses, never imported, the same way
 * `styleCompile.test.ts` genuinely spawns `styleCompileWorker.ts`. This is
 * the one test in this feature that actually proves the load-bearing,
 * hard-to-verify assumption the whole Stop-hook mechanism depends on: that
 * `@core/*`/relative Studio-internal imports resolve correctly inside a
 * script invoked as `bun <absolute-path>` with `cwd` set to the USER's
 * project (never this repo's own root) — the exact shape `claude`'s own
 * hook runner uses. A unit test that imports `main()` directly would never
 * catch a module-resolution break at this boundary; only a real spawn does.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPages } from '../../studioPageLoad'
import { createScaffoldedPage } from '../pageScaffold'
import { resolvePageSourceFile } from '../pageSourceFile'
import { registerDesignReference } from '../designReferenceStore'
import { readTurnWriteLog } from '../turnWriteLog'

const RECORD_SCRIPT = path.join(import.meta.dir, 'recordToolWrite.ts')
const GATE_SCRIPT = path.join(import.meta.dir, 'stopGateCheck.ts')

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function run(script: string, stdin: unknown): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, script], {
    stdin: new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

let dir: string
async function freshDir(): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hooks-'))
  return dir
}

describe('recordToolWrite.ts (spawned)', () => {
  it('appends a real entry to the turn write log', async () => {
    const projectDir = await freshDir()
    try {
      const filePath = path.join(projectDir, 'pages', 'Onboarding.tsx')
      const result = await run(RECORD_SCRIPT, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'x' },
        cwd: projectDir,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('') // never noise in the transcript
      expect(readTurnWriteLog(projectDir)).toEqual([{ file: 'pages/Onboarding.tsx', atMs: expect.any(Number) }])
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('is a no-op, still exit 0, when there is no file_path (a Read/Glob call would never reach this hook, but a malformed input must not crash it)', async () => {
    const projectDir = await freshDir()
    try {
      const result = await run(RECORD_SCRIPT, { hook_event_name: 'PostToolUse', cwd: projectDir })
      expect(result.exitCode).toBe(0)
      expect(readTurnWriteLog(projectDir)).toEqual([])
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('stopGateCheck.ts (spawned)', () => {
  it('allows the stop silently when nothing was written this turn', async () => {
    const projectDir = await freshDir()
    try {
      createScaffoldedPage(projectDir, 'Onboarding')
      const result = await run(GATE_SCRIPT, { hook_event_name: 'Stop', cwd: projectDir, stop_hook_active: false })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('')
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('blocks with a specific, actionable reason for a page written this turn with no reference armed', async () => {
    const projectDir = await freshDir()
    try {
      const scaffolded = createScaffoldedPage(projectDir, 'Onboarding')
      if (!scaffolded.ok) throw new Error(scaffolded.conflict)
      const { pages } = await loadStudioPages(projectDir)
      const page = pages.find((p) => p.id === scaffolded.pageId)!
      const rel = resolvePageSourceFile(page)!

      // Record the write via the REAL record hook, so this test proves the
      // two scripts actually agree on the file's stdin shape and on-disk
      // format — not two independently-guessed fixtures.
      const recorded = await run(RECORD_SCRIPT, {
        tool_input: { file_path: path.join(projectDir, rel) },
        cwd: projectDir,
      })
      expect(recorded.exitCode).toBe(0)

      const result = await run(GATE_SCRIPT, { hook_event_name: 'Stop', cwd: projectDir, stop_hook_active: false })
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as { decision: string; reason: string }
      expect(parsed.decision).toBe('block')
      expect(parsed.reason).toContain('Onboarding')
      expect(parsed.reason).toContain('studio_register_design_reference')
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('never blocks twice in the same stop cycle — stop_hook_active always allows through', async () => {
    const projectDir = await freshDir()
    try {
      const scaffolded = createScaffoldedPage(projectDir, 'Onboarding')
      if (!scaffolded.ok) throw new Error(scaffolded.conflict)
      const { pages } = await loadStudioPages(projectDir)
      const page = pages.find((p) => p.id === scaffolded.pageId)!
      const rel = resolvePageSourceFile(page)!
      await run(RECORD_SCRIPT, { tool_input: { file_path: path.join(projectDir, rel) }, cwd: projectDir })

      const result = await run(GATE_SCRIPT, { hook_event_name: 'Stop', cwd: projectDir, stop_hook_active: true })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('')
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('stays silent once the page has a registered reference and a passing compare recorded after the write', async () => {
    const projectDir = await freshDir()
    try {
      const scaffolded = createScaffoldedPage(projectDir, 'Onboarding')
      if (!scaffolded.ok) throw new Error(scaffolded.conflict)
      const { pages } = await loadStudioPages(projectDir)
      const page = pages.find((p) => p.id === scaffolded.pageId)!
      const rel = resolvePageSourceFile(page)!

      const registered = await registerDesignReference(projectDir, ONE_PIXEL_PNG, { pageId: page.id })
      if (!registered.ok) throw new Error(registered.error)

      await run(RECORD_SCRIPT, { tool_input: { file_path: path.join(projectDir, rel) }, cwd: projectDir })
      // Record the passing verdict AFTER the write it covers, via the real store module.
      const { recordPassingCompare } = await import('../pageVerificationStore')
      recordPassingCompare(projectDir, page.id, registered.reference.id)

      const result = await run(GATE_SCRIPT, { hook_event_name: 'Stop', cwd: projectDir, stop_hook_active: false })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('')
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails open (exit 0, no block) when cwd is missing from stdin', async () => {
    const result = await run(GATE_SCRIPT, { hook_event_name: 'Stop', stop_hook_active: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })
})
