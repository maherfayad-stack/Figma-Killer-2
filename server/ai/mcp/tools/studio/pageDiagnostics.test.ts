/**
 * `studio_page_diagnostics` — registration, posture, honest failure, and
 * doc ⇄ code parity.
 *
 * The parity check is the same contract `fidelityCodes.test.ts` enforces: a
 * finding code is a machine-readable promise, so it may not exist without a
 * documented meaning, and the doc may not describe one the code cannot emit.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_DIAGNOSTIC_CODES, PAGE_DIAGNOSTIC_CODE_LIST } from '@core/ai'
import { studioPageDiagnosticsTool } from './pageDiagnostics'
import { studioMcpTools } from './index'
import { STUDIO_AGENT_TOOL_NAMES } from '../../../tools/studio/agentToolNames'
import { mcpToolsForCapabilities } from '../../registry'
import type { ToolContext } from '../../../runtime/types'

const DOC_PATH = join(import.meta.dir, '../../../../../docs/features/mcp-connectors.md')

describe('studio_page_diagnostics registration', () => {
  it('is in the MCP registry exactly once', () => {
    expect(studioMcpTools.filter((t) => t.name === 'studio_page_diagnostics')).toHaveLength(1)
  })

  it('is offered to the in-canvas agent', () => {
    expect(STUDIO_AGENT_TOOL_NAMES).toContain('studio_page_diagnostics')
  })

  it('is a pure read: no mutates, no required capabilities', () => {
    // Consequences, both deliberate: an `ai.chat`-only connector can call it,
    // and PR #9's parallel dispatch may batch it with other reads.
    expect(studioPageDiagnosticsTool.mutates).toBeUndefined()
    expect(studioPageDiagnosticsTool.requiredCapabilities ?? []).toEqual([])
  })

  it('is visible to a read-only connector', () => {
    const names = mcpToolsForCapabilities(['ai.chat']).map((t) => t.name)
    expect(names).toContain('studio_page_diagnostics')
  })

  it('takes an object at the top level, with no caller-supplied write target', () => {
    const schema = studioPageDiagnosticsTool.inputSchema as { type?: string; properties?: Record<string, unknown> }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['dir', 'limit', 'pages'])
  })
})

describe('studio_page_diagnostics failure messages', () => {
  it('names the missing precondition when no board is connected', async () => {
    const ctx = {
      db: {} as never,
      userId: 'no-bridge-user',
      capabilities: ['ai.chat'],
      conversationId: 'c1',
      snapshot: undefined,
      signal: AbortSignal.abort(),
    } as unknown as ToolContext

    const out = await studioPageDiagnosticsTool.handler!({ dir: '/nonexistent' }, ctx)
    const result = out as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    // The message must say WHERE the precondition lives and that it self-heals,
    // not just return an empty result that reads as "nothing is wrong".
    expect(result.error).toContain('No Studio board is connected')
    expect(result.error).toContain('Studio browser tab')
  })
})

describe('finding-code vocabulary', () => {
  const doc = readFileSync(DOC_PATH, 'utf8')

  it('every code is documented in mcp-connectors.md', () => {
    const undocumented = PAGE_DIAGNOSTIC_CODE_LIST.filter((code) => !doc.includes(`\`${code}\``))
    expect(undocumented).toEqual([])
  })

  it('every code in the doc table is a real code', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| /gm)].map((m) => m[1]!)
    const diagnosticRows = rows.filter((code) => code.startsWith('runtime-') || code.endsWith('-failed'))
    expect(diagnosticRows.length).toBeGreaterThan(0)
    for (const code of diagnosticRows) {
      expect(PAGE_DIAGNOSTIC_CODE_LIST).toContain(code as (typeof PAGE_DIAGNOSTIC_CODE_LIST)[number])
    }
  })

  it('every code carries a fix, not just a title', () => {
    for (const code of PAGE_DIAGNOSTIC_CODE_LIST) {
      const def = PAGE_DIAGNOSTIC_CODES[code]
      expect(def.code).toBe(code)
      expect(def.title.length).toBeGreaterThan(3)
      // A diagnostic with no suggested action is a symptom, not a finding.
      expect(def.fix.length).toBeGreaterThan(20)
    }
  })
})
