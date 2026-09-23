/**
 * Architecture Gate — `docs/features/agent.md` describes the agent's tool
 * surface as the code has it, not as it was (AI-24).
 *
 * Three claims in that doc had quietly gone stale, each one a number or a
 * status someone typed by hand:
 *
 *   - "`STUDIO_AGENT_TOOL_NAMES` currently names 31 tools" — it named 35;
 *   - the tool index said `studio_screenshot` and `studio_compare` were
 *     ungated reads (both have always required `studio.write`), described two
 *     server tools as browser-bridged, and left `studio_measure_element` out;
 *   - the parity section listed six withheld actions, one of which (a
 *     full-file overwrite) no longer existed, and `parityMatrix.ts` itself
 *     still said `Task` was not granted a wave after it was.
 *
 * A doc cannot compute, so each claim is pinned here against the value it
 * restates.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STUDIO_AGENT_TOOL_NAMES } from '../../../server/ai/tools/studio/agentToolNames'
import { STUDIO_CANVAS_PARITY_MATRIX } from '../../../server/ai/tools/studio/parityMatrix'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { resolveNativeToolAllowlist } from '../../../server/ai/drivers/claudeCliToolSurface'

const AGENT_DOC = readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'features', 'agent.md'), 'utf8')

function between(start: string, end: string): string {
  const from = AGENT_DOC.indexOf(start)
  const to = AGENT_DOC.indexOf(end)
  expect(from, `${start} is missing from agent.md`).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return AGENT_DOC.slice(from, to)
}

/** The `| a | b | … |` rows of a markdown table block, header and divider dropped, cells trimmed. */
function tableRows(block: string): string[][] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split(' | ').map((cell) => cell.trim()))
}

describe('agent.md states the tool surface the code actually has', () => {
  it('the tool count is the length of STUDIO_AGENT_TOOL_NAMES', () => {
    const match = /currently names (\d+) tools/.exec(AGENT_DOC)
    expect(match, 'the "currently names N tools" sentence is missing').not.toBeNull()
    expect(Number(match![1])).toBe(STUDIO_AGENT_TOOL_NAMES.length)
  })

  it('the tool index lists exactly the offered tools, in STUDIO_AGENT_TOOL_NAMES order', () => {
    const rows = tableRows(between('<!-- agent-tool-index:start -->', '<!-- agent-tool-index:end -->'))
    expect(rows.map((row) => row[0]!.replace(/`/g, ''))).toEqual([...STUDIO_AGENT_TOOL_NAMES])
  })

  it('each index row\'s execution, gate and loop columns match the tool\'s own metadata', () => {
    const byName = new Map(studioAgentTools.map((tool) => [tool.name, tool]))
    for (const [nameCell, whereCell, gateCell, loopCell] of tableRows(between('<!-- agent-tool-index:start -->', '<!-- agent-tool-index:end -->'))) {
      const tool = byName.get(nameCell!.replace(/`/g, ''))!
      expect(whereCell!.startsWith(`\`${tool.execution}\``), `${tool.name}: "Where it runs" says ${whereCell}, the tool says ${tool.execution}`).toBe(true)
      const caps = tool.requiredCapabilities ?? []
      if (gateCell === 'read') {
        expect(tool.requiresWrite ?? false, `${tool.name} is documented as a read but is write-gated`).toBe(false)
        expect(caps, `${tool.name} is documented as a read but requires capabilities`).toEqual([])
      } else {
        expect(tool.requiresWrite, `${tool.name} is documented as gated but is not requiresWrite`).toBe(true)
        for (const cap of caps) expect(gateCell, `${tool.name}'s Gate column omits ${cap}`).toContain(`\`${cap}\``)
      }
      expect(loopCell, `${tool.name}'s Loop column`).toBe(`\`${tool.sideEffects}\``)
    }
  })

  it('the withheld-actions table is the parity matrix\'s withheld rows', () => {
    const documented = tableRows(between('<!-- parity-withheld:start -->', '<!-- parity-withheld:end -->')).map((row) => row[0])
    const withheld = STUDIO_CANVAS_PARITY_MATRIX.filter((row) => row.status.kind === 'withheld').map((row) => row.action)
    expect(documented).toEqual(withheld)
  })

  it('the parity matrix does not withhold a native tool the CLI actually grants', () => {
    // The Task row said "withheld" while `claudeCliToolSurface.ts` granted it.
    const granted = resolveNativeToolAllowlist('/some/project', false).split(',')
    expect(granted).toContain('Task')
    for (const row of STUDIO_CANVAS_PARITY_MATRIX) {
      if (row.status.kind !== 'withheld') continue
      for (const tool of granted) {
        expect(row.status.reason, `"${row.action}" is withheld for a reason that says ${tool} is not granted`).not.toContain(`${tool} is not granted`)
      }
    }
    const delegate = STUDIO_CANVAS_PARITY_MATRIX.find((row) => row.action === 'Delegate to a subagent')
    expect(delegate?.status.kind).toBe('native')
  })
})
