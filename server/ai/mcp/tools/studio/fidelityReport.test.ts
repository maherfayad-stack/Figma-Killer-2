import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioFidelityReportTool } from './fidelityReport'

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('studio_fidelity_report', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-fidelity-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports a fully-static page as fully resolved with no findings', async () => {
    write(
      tmpDir,
      'pages/Home.tsx',
      ['export default function Home() {', '  return <div className="hero">Hello</div>', '}', ''].join('\n'),
    )

    const result = (await studioFidelityReportTool.handler!({ dir: tmpDir }, {} as never)) as {
      pages: Array<{ pageId: string; score: { nodes: number; locked: number }; findings: unknown[] }>
    }
    expect(result.pages.length).toBe(1)
    expect(result.pages[0]!.score.locked).toBe(0)
    expect(result.pages[0]!.findings).toEqual([])
  })

  it('flags a spread-props element with SPREAD_PROPS_UNRESOLVED', async () => {
    write(
      tmpDir,
      'pages/Home.tsx',
      [
        'export default function Home(props) {',
        '  return <div {...props}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    const result = (await studioFidelityReportTool.handler!({ dir: tmpDir }, {} as never)) as {
      pages: Array<{ findingCounts: Record<string, number>; findings: Array<{ code: string; nodeId: string; fix: string }> }>
    }
    const page = result.pages[0]!
    expect(page.findingCounts.SPREAD_PROPS_UNRESOLVED).toBeGreaterThan(0)
    const finding = page.findings.find((f) => f.code === 'SPREAD_PROPS_UNRESOLVED')!
    expect(finding.fix.length).toBeGreaterThan(0)
  })

  it('a multi-return component no longer stacks both branches (parser-06) — BRANCH_AUTO_SELECTED replaces MULTI_BRANCH_ALL_RENDERED', async () => {
    // Before parser-06, EVERY `return` rendered, stacked and locked
    // ('one branch of several — chosen in code'), which is exactly what the
    // now-retired MULTI_BRANCH_ALL_RENDERED code flagged. The parser now
    // SELECTS the last return (the component's "normal" state) and leaves it
    // unlocked, recording the other branch as a label + location on the
    // chosen node via `PageNode.branchAlternatives` — `mcp-02` reads that
    // field to emit BRANCH_AUTO_SELECTED (info, not a defect) instead.
    write(
      tmpDir,
      'pages/Home.tsx',
      [
        'export default function Home({ ok }) {',
        '  if (ok) {',
        '    return <div>Yes</div>',
        '  }',
        '  return <div>No</div>',
        '}',
        '',
      ].join('\n'),
    )

    const result = (await studioFidelityReportTool.handler!({ dir: tmpDir }, {} as never)) as {
      pages: Array<{
        score: { nodes: number; locked: number }
        findingCounts: Record<string, number>
        findings: Array<{ code: string; nodeId: string; message: string; fix: string }>
      }>
    }
    const page = result.pages[0]!
    expect(page.findingCounts.MULTI_BRANCH_ALL_RENDERED).toBeUndefined()
    // The synthesized `base.body` root plus the chosen ("No") branch's one
    // <div> — the "Yes" branch was never parsed into a node at all.
    expect(page.score.nodes).toBe(2)
    expect(page.score.locked).toBe(0)

    expect(page.findingCounts.BRANCH_AUTO_SELECTED).toBe(1)
    const finding = page.findings.find((f) => f.code === 'BRANCH_AUTO_SELECTED')!
    expect(finding).toBeDefined()
    // The alternate's label is derived from the guard's own condition text
    // (`if (ok) return <div>Yes</div>` labels "ok" — see `deriveBranchLabel`
    // in `branchSelection.ts`), not the branch's rendered content.
    expect(finding.message).toContain('ok')
    expect(finding.message).toContain('Home.tsx')
    expect(finding.fix.length).toBeGreaterThan(0)
  })

  it('surfaces the project probe warnings as projectFindings, reusing the same codes', async () => {
    // No pages dir at all — the probe should emit pages-dir-not-found.
    const result = (await studioFidelityReportTool.handler!({ dir: tmpDir }, {} as never)) as {
      projectFindings: Array<{ code: string; message: string; fix: string }>
    }
    expect(result.projectFindings.some((f) => f.code === 'pages-dir-not-found')).toBe(true)
  })
})
