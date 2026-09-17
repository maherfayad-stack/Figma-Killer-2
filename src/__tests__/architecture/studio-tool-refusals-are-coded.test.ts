/**
 * Architecture Gate — a Studio tool refuses with a code, never with prose.
 *
 * ## What this holds shut (A14)
 *
 * The consumer of these tools is often a small model. Before this, a refusal
 * was whatever each tool felt like returning: a bare
 * `aiToolError('No screen matched "Chekout"…')` in one file, an
 * `{ ok: false, code }` in another, an `{ ok: false, error }` with no code in
 * a third. Three things followed, all paid by the caller:
 *
 *   - nothing was machine-readable, so the model pattern-matched on prose;
 *   - nothing said whether a retry was pointless, which is the single largest
 *     source of wasted rounds in an observed turn;
 *   - nothing said what to do instead.
 *
 * Two rules, enforced on the source because the alternative — calling every
 * refusal path of every tool — would need a whole fixture project per branch:
 *
 *   1. No `aiToolError` inside `server/ai/mcp/tools/studio/`. That helper
 *      produces `{ ok: false, error }` with no code by construction. It stays
 *      for the CMS half, which has its own conventions.
 *   2. Every documented code is real, and every real code is documented.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_REFUSAL_CODES, TOOL_REFUSAL_CODE_LIST } from '../../core/ai/toolRefusal'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const STUDIO_TOOLS_DIR = join(REPO_ROOT, 'server', 'ai', 'mcp', 'tools', 'studio')
const AGENT_DOC = join(REPO_ROOT, 'docs', 'features', 'agent.md')

function studioToolSources(): { name: string; source: string }[] {
  return readdirSync(STUDIO_TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(STUDIO_TOOLS_DIR, name), 'utf8') }))
}

describe('Studio tool refusals are structured', () => {
  it('no studio tool reaches for the code-less aiToolError helper', () => {
    const offenders = studioToolSources()
      .filter(({ source }) => /\baiToolError\s*\(/.test(source))
      .map(({ name }) => name)
    expect(
      offenders,
      `These files still refuse without a code. Use toolRefusal(code, message, { remedy }) from @core/ai: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('every code a studio tool actually passes to toolRefusal is in the vocabulary', () => {
    // Catches a typo'd literal that TypeScript would normally reject, and a
    // code introduced through a variable that was never added to the table.
    const known = new Set<string>(TOOL_REFUSAL_CODE_LIST)
    const unknown: string[] = []
    for (const { name, source } of studioToolSources()) {
      for (const match of source.matchAll(/toolRefusal\(\s*'([^']+)'/g)) {
        const code = match[1]!
        if (!known.has(code)) unknown.push(`${name}: ${code}`)
      }
    }
    expect(unknown, `Unknown refusal codes: ${unknown.join(', ')}`).toEqual([])
  })

  it('at least one tool refuses with each of the codes the prompt leans on', () => {
    // A code documented but never produced is a promise to the agent nothing
    // keeps. These four are the ones the system prompt's own retry rule and
    // the Tier-2 gate name by example.
    const produced = new Set<string>()
    for (const { source } of studioToolSources()) {
      for (const match of source.matchAll(/toolRefusal\(\s*'([^']+)'/g)) produced.add(match[1]!)
    }
    for (const code of ['no-such-page', 'trust-tier-required', 'no-such-reference', 'invalid-input']) {
      expect(produced.has(code), `nothing produces the ${code} refusal any more`).toBe(true)
    }
  })
})

describe('the refusal vocabulary is documented', () => {
  it('every code has a row in docs/features/agent.md', () => {
    const doc = readFileSync(AGENT_DOC, 'utf8')
    const undocumented = TOOL_REFUSAL_CODE_LIST.filter((code) => !doc.includes(`\`${code}\``))
    expect(
      undocumented,
      `Add a row to agent.md's refusal-code table for: ${undocumented.join(', ')}`,
    ).toEqual([])
  })

  it('the doc does not invent a code the code table does not have', () => {
    const doc = readFileSync(AGENT_DOC, 'utf8')
    // Only the refusal-code table's own rows, so an unrelated backticked
    // identifier elsewhere in the doc is not mistaken for a code.
    const tableStart = doc.indexOf('<!-- refusal-codes:start -->')
    const tableEnd = doc.indexOf('<!-- refusal-codes:end -->')
    expect(tableStart, 'the refusal-code table markers are missing from agent.md').toBeGreaterThan(-1)
    expect(tableEnd).toBeGreaterThan(tableStart)
    const table = doc.slice(tableStart, tableEnd)
    const documented = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!)
    expect(documented.length).toBe(TOOL_REFUSAL_CODE_LIST.length)
    for (const code of documented) {
      expect(TOOL_REFUSAL_CODES[code as keyof typeof TOOL_REFUSAL_CODES], `${code} is documented but does not exist`).toBeDefined()
    }
  })

  it('the documented retryable column matches the code table', () => {
    const doc = readFileSync(AGENT_DOC, 'utf8')
    const table = doc.slice(doc.indexOf('<!-- refusal-codes:start -->'), doc.indexOf('<!-- refusal-codes:end -->'))
    for (const match of table.matchAll(/^\| `([a-z0-9-]+)` \| (yes|no) \|/gm)) {
      const code = match[1]! as keyof typeof TOOL_REFUSAL_CODES
      const documented = match[2] === 'yes'
      expect(TOOL_REFUSAL_CODES[code].retryable, `${code}'s retryable column disagrees with the code table`).toBe(documented)
    }
  })
})
