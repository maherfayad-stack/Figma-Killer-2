/**
 * `studio_typecheck` — tool wiring coverage: trust-tier gate, capability
 * shape, not-available reasons, and the `paths` scope filter, end to end
 * against a real (but FAKE) `node_modules/typescript/bin/tsc` a fixture
 * project supplies — this really spawns and really parses, unlike
 * `../../../../handlers/studio/typecheck.test.ts`'s stubbed-spawn coverage
 * of the engine's own timeout/error/argv contracts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioTypecheckMcpTools } from './typecheck'

const studioTypecheckTool = studioTypecheckMcpTools[0]

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** A fake `tsc` that unconditionally reports two canned diagnostics in two different files and exits 2 — real spawn, real stdout parse, canned content (the actual TypeScript compilation semantics are exercised in `typecheck.test.ts`'s stubbed-spawn coverage and were hand-verified against the real compiler while building this tool). */
function installFakeTscWithDiagnostics(dir: string): void {
  write(
    dir,
    'node_modules/typescript/bin/tsc',
    [
      "process.stdout.write(\"src/screens/Home.tsx(2,3): error TS2322: Type 'string' is not assignable to type 'number'.\\n\")",
      "process.stdout.write(\"src/screens/Other.tsx(5,10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.\\n\")",
      'process.exit(2)',
      '',
    ].join('\n'),
  )
}

function installFakeCleanTsc(dir: string): void {
  write(dir, 'node_modules/typescript/bin/tsc', 'process.exit(0)\n')
}

function promoteTrust(dir: string): void {
  write(dir, '.studio/meta.json', JSON.stringify({ trust: 'render-packages' }))
}

describe('studio_typecheck', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-typecheck-tool-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('requires ai.tools.write (mutates) AND studio.write — the same double gate as studio_install_deps', () => {
    expect(studioTypecheckTool.mutates).toBe(true)
    expect(studioTypecheckTool.requiredCapabilities).toEqual(['studio.write'])
  })

  it('refuses at the default Tier 0 (static) trust — no .studio/meta.json at all', async () => {
    write(dir, 'tsconfig.json', '{}')
    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as { ok: boolean; code?: string; error?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('trust-tier-required')
    expect(result.error).toMatch(/Tier 0/)
  })

  it('refuses at an EXPLICIT static trust tier too', async () => {
    write(dir, 'tsconfig.json', '{}')
    write(dir, '.studio/meta.json', JSON.stringify({ trust: 'static' }))
    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('trust-tier-required')
  })

  it('reports available:false with reason no-tsconfig once promoted, when the project has no tsconfig.json', async () => {
    promoteTrust(dir)
    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as { ok: boolean; available?: boolean; reason?: string; fix?: string }
    expect(result.ok).toBe(false)
    expect(result.available).toBe(false)
    expect(result.reason).toBe('no-tsconfig')
    expect(result.fix).toBeTruthy()
  })

  it('reports available:false with reason typescript-not-installed once promoted, when typescript is not installed', async () => {
    promoteTrust(dir)
    write(dir, 'tsconfig.json', '{}')
    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as { ok: boolean; available?: boolean; reason?: string; fix?: string }
    expect(result.ok).toBe(false)
    expect(result.available).toBe(false)
    expect(result.reason).toBe('typescript-not-installed')
    expect(result.fix).toMatch(/studio_install_deps/)
  })

  it('passes cleanly with pass:true and no diagnostics against a clean project', async () => {
    promoteTrust(dir)
    write(dir, 'tsconfig.json', '{}')
    installFakeCleanTsc(dir)

    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as {
      ok: boolean
      pass: boolean
      scope: string
      diagnostics: unknown[]
      diagnosticCount: number
      totalDiagnosticCount: number
    }
    expect(result.ok).toBe(true)
    expect(result.pass).toBe(true)
    expect(result.scope).toBe('project')
    expect(result.diagnostics).toEqual([])
    expect(result.diagnosticCount).toBe(0)
    expect(result.totalDiagnosticCount).toBe(0)
  })

  it('reports every diagnostic, sorted, in project scope when no paths are requested', async () => {
    promoteTrust(dir)
    write(dir, 'tsconfig.json', '{}')
    installFakeTscWithDiagnostics(dir)

    const result = (await studioTypecheckTool.handler!({ dir }, {} as never)) as {
      ok: boolean
      pass: boolean
      scope: string
      diagnostics: Array<{ file: string; code: string }>
      diagnosticCount: number
      totalDiagnosticCount: number
      truncated: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.pass).toBe(false)
    expect(result.scope).toBe('project')
    expect(result.diagnosticCount).toBe(2)
    expect(result.totalDiagnosticCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.diagnostics.map((d) => d.file)).toEqual(['src/screens/Home.tsx', 'src/screens/Other.tsx'])
  })

  it('filters to the requested paths, reports scope:"filtered", and names how many diagnostics exist outside it', async () => {
    promoteTrust(dir)
    write(dir, 'tsconfig.json', '{}')
    installFakeTscWithDiagnostics(dir)

    const result = (await studioTypecheckTool.handler!({ dir, paths: ['Home.tsx'] }, {} as never)) as {
      ok: boolean
      pass: boolean
      scope: string
      diagnostics: Array<{ file: string }>
      diagnosticCount: number
      totalDiagnosticCount: number
      requestedPaths?: string[]
      note?: string
    }
    expect(result.ok).toBe(true)
    expect(result.scope).toBe('filtered')
    expect(result.pass).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].file).toBe('src/screens/Home.tsx')
    expect(result.diagnosticCount).toBe(1)
    expect(result.totalDiagnosticCount).toBe(2)
    expect(result.requestedPaths).toEqual(['Home.tsx'])
    expect(result.note).toMatch(/1 diagnostic/)
  })

  it('filtering to a path with no diagnostics reports pass:true for that scope, without implying the whole project is clean', async () => {
    promoteTrust(dir)
    write(dir, 'tsconfig.json', '{}')
    installFakeTscWithDiagnostics(dir)

    const result = (await studioTypecheckTool.handler!({ dir, paths: ['NothingWrongHere.tsx'] }, {} as never)) as {
      ok: boolean
      pass: boolean
      scope: string
      diagnostics: unknown[]
      totalDiagnosticCount: number
      note?: string
    }
    expect(result.ok).toBe(true)
    expect(result.pass).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.totalDiagnosticCount).toBe(2)
    // pass:true is scoped to the (empty) filtered result — the note must
    // still say the 2 project-wide diagnostics exist, never imply the whole
    // project is clean just because the requested path had nothing.
    expect(result.note).toMatch(/2 diagnostic\(s\) exist elsewhere/)
  })
})
