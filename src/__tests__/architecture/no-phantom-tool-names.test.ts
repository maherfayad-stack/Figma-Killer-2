/**
 * Architecture Gate — nothing the agent reads names a tool it was not offered
 * (A11, extended by AI-6).
 *
 * ## The failure class
 *
 * `server/ai/tools/studio/systemPrompt.test.ts` already holds the static prompt
 * PREFIX to "every studio_* name is a registered tool". Everything else the
 * model reads was unwatched, and it had drifted:
 *
 *   - the FOLLOW design-policy block told the agent `studio_design_system_guide`
 *     was "the menu" — a tool that has never existed;
 *   - a quality finding's fix text sent it to the same phantom for icon names;
 *   - ten tool descriptions offered to the in-canvas agent named tools only an
 *     external MCP client holds (`studio_diff_frames`, `studio_find_nodes`,
 *     `studio_apply_edits`, …), and a result hint or refusal remedy did the
 *     same.
 *
 * A phantom is the expensive kind of wrong. The model calls it, gets
 * "Unknown tool", and either burns a round recovering or concludes the thing
 * it wanted cannot be done.
 *
 * ## What "offered" means, per path
 *
 *   - **In-canvas** (`studioAgentTools`: the HTTP driver with a project open,
 *     and the connector the `claude` CLI is bound to): the mode and policy
 *     blocks, the whole system prompt, every offered tool's description and
 *     input-schema field descriptions, every string a module that hosts ONLY
 *     offered tools can return (result hints, refusal remedies), and the
 *     finding text `studio_quality_check` / `studio_fidelity_report` produce.
 *   - **In-canvas on an HTTP driver** (`studioHttpAgentTools`: the above plus
 *     the file tools, P4-C): the same checks against that larger surface —
 *     its prompt names Studio's file tools, and those tools' own text and
 *     refusal remedies may name each other, but nothing beyond the surface.
 *   - **External MCP** (`mcpToolsForCapabilities`, an unbound client): every
 *     registered tool's description and field descriptions may name only
 *     registered tools.
 *
 * Offered means "on the surface", with every capability held. A read-only
 * caller being told a write tool's name is an honest "exists, not granted",
 * not a phantom.
 */
import { describe, expect, it } from 'bun:test'
import { dirname, join, relative, sep } from 'node:path'
import { Node, Project } from 'ts-morph'
import { studioAgentTools, studioHttpAgentTools } from '../../../server/ai/tools/studio'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'
import { DESIGN_POLICY_BLOCK, MODE_BLOCK } from '../../../server/ai/tools/studio/promptSessionBlocks'
import { mcpToolsForCapabilities } from '../../../server/ai/mcp/registry'
import type { AiTool } from '../../../server/ai/runtime/types'
import { CORE_CAPABILITIES } from '../../core/capabilities'
import { walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const STUDIO_TOOLS_DIR = join(REPO_ROOT, 'server', 'ai', 'mcp', 'tools', 'studio')

/** The modules whose strings become finding / fix text returned by an in-canvas tool. */
const FINDING_TEXT_MODULES = [
  'server/handlers/studio/qualityAudit.ts',
  'server/handlers/studio/compositionAudit.ts',
  'server/handlers/studio/tscDiagnostics.ts',
  'server/ai/mcp/tools/studio/fontAvailability.ts',
  'server/ai/mcp/tools/studio/fidelityCodes.ts',
]

const IN_CANVAS = new Set(studioAgentTools.map((tool) => tool.name))
const IN_CANVAS_HTTP = new Set(studioHttpAgentTools.map((tool) => tool.name))
const REGISTRY_TOOLS = mcpToolsForCapabilities([...CORE_CAPABILITIES])
const REGISTRY = new Set(REGISTRY_TOOLS.map((tool) => tool.name))

/** Every `studio_*` name in `text`. */
function toolNamesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bstudio_[a-z_]+\b/g)].map((m) => m[0]))]
}

/** A tool's description plus every `description` inside its input schema — the whole interface the model reads. */
function interfaceText(tool: AiTool): string {
  const texts: string[] = [tool.description]
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.description === 'string') texts.push(record.description)
    for (const child of Object.values(record)) walk(child)
  }
  walk(tool.inputSchema)
  return texts.join('\n')
}

/** Every string and template literal in a source file — comments excluded, which is the point of parsing it. */
function stringLiterals(project: Project, relPath: string): Array<{ line: number; text: string }> {
  const sourceFile = project.addSourceFileAtPath(join(REPO_ROOT, relPath))
  const out: Array<{ line: number; text: string }> = []
  sourceFile.forEachDescendant((node) => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: node.getStartLineNumber(), text: node.getLiteralText() })
    } else if (Node.isTemplateExpression(node)) {
      out.push({ line: node.getStartLineNumber(), text: node.getText() })
    }
  })
  return out
}

function phantomsIn(text: string, offered: ReadonlySet<string>): string[] {
  return toolNamesIn(text).filter((name) => !offered.has(name))
}

/**
 * The Studio tool modules that host ONLY in-canvas tools, found by importing
 * each one and reading what it exports — so a file that also hosts an
 * MCP-only tool (whose own text may rightly name MCP-only siblings) is not
 * held to the in-canvas rule, and a new in-canvas-only module is picked up
 * without an edit here.
 */
async function inCanvasOnlyModules(offered: ReadonlySet<string> = IN_CANVAS): Promise<string[]> {
  const out: string[] = []
  // Direct children only: a tool module lives at the top of the studio tools folder.
  for (const absPath of walkSourceTree(STUDIO_TOOLS_DIR, ['.ts'])) {
    if (dirname(absPath) !== STUDIO_TOOLS_DIR || absPath.endsWith('.test.ts')) continue
    const exported = Object.values(await import(absPath) as Record<string, unknown>)
    const names = exported
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is AiTool =>
        typeof value === 'object' && value !== null && typeof (value as AiTool).name === 'string' && 'inputSchema' in value)
      .map((tool) => tool.name)
    if (names.length > 0 && names.every((name) => offered.has(name))) out.push(relative(REPO_ROOT, absPath).split(sep).join('/'))
  }
  return out
}

describe('the in-canvas agent is never told about a tool it does not have', () => {
  it('the phantom that started this is gone', () => {
    const everything = [
      ...Object.values(MODE_BLOCK),
      ...Object.values(DESIGN_POLICY_BLOCK),
      ...studioAgentTools.map(interfaceText),
    ].join('\n')
    expect(everything).not.toContain('studio_design_system_guide')
  })

  it('every mode block and every design-policy block', () => {
    const blocks = { ...Object.fromEntries(Object.entries(MODE_BLOCK).map(([k, v]) => [`mode:${k}`, v])), ...Object.fromEntries(Object.entries(DESIGN_POLICY_BLOCK).map(([k, v]) => [`policy:${k}`, v])) }
    expect(Object.keys(blocks).length).toBeGreaterThanOrEqual(6)
    const offenders = Object.entries(blocks).flatMap(([key, text]) => phantomsIn(text, IN_CANVAS).map((name) => `${key} names ${name}`))
    expect(offenders).toEqual([])
  })

  it('the whole system prompt, prefix and suffix', () => {
    const prompt = buildStudioAgentSystemPrompt(null, studioAgentTools).join('\n')
    expect(phantomsIn(prompt, IN_CANVAS)).toEqual([])
  })

  it('every offered tool\'s description and input-field descriptions', () => {
    const offenders = studioAgentTools.flatMap((tool) =>
      phantomsIn(interfaceText(tool), IN_CANVAS).map((name) => `${tool.name}'s description names ${name}`))
    expect(offenders).toEqual([])
  })

  it('every string a module hosting only offered tools can return (result hints, refusal remedies)', async () => {
    const modules = await inCanvasOnlyModules()
    // Vacuity guard: the screenshot, compare and quality-check modules are the
    // agent's core loop and host nothing else.
    for (const expected of ['screenshot.ts', 'compare.ts', 'qualityCheck.ts']) {
      expect(modules).toContain(`server/ai/mcp/tools/studio/${expected}`)
    }
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    const offenders = modules.flatMap((relPath) =>
      stringLiterals(project, relPath).flatMap(({ line, text }) =>
        phantomsIn(text, IN_CANVAS).map((name) => `${relPath}:${line} names ${name}`)))
    expect(offenders).toEqual([])
  })

  it('every finding and fix text studio_quality_check / studio_fidelity_report can return', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    const offenders = FINDING_TEXT_MODULES.flatMap((relPath) =>
      stringLiterals(project, relPath).flatMap(({ line, text }) =>
        phantomsIn(text, IN_CANVAS).map((name) => `${relPath}:${line} names ${name}`)))
    expect(offenders).toEqual([])
  })
})

describe('the HTTP-driver agent is never told about a tool it does not have (P4-C)', () => {
  it('its whole system prompt, prefix and suffix', () => {
    const prompt = buildStudioAgentSystemPrompt(null, studioHttpAgentTools).join('\n')
    expect(phantomsIn(prompt, IN_CANVAS_HTTP)).toEqual([])
  })

  it('every offered tool\'s description and input-field descriptions', () => {
    const offenders = studioHttpAgentTools.flatMap((tool) =>
      phantomsIn(interfaceText(tool), IN_CANVAS_HTTP).map((name) => `${tool.name}'s description names ${name}`))
    expect(offenders).toEqual([])
  })

  it('every string a module hosting only its tools can return', async () => {
    const modules = await inCanvasOnlyModules(IN_CANVAS_HTTP)
    for (const expected of ['fileReadTools.ts', 'fileWriteTools.ts']) {
      expect(modules).toContain(`server/ai/mcp/tools/studio/${expected}`)
    }
    const project = new Project({ skipAddingFilesFromTsConfig: true })
    const offenders = modules.flatMap((relPath) =>
      stringLiterals(project, relPath).flatMap(({ line, text }) =>
        phantomsIn(text, IN_CANVAS_HTTP).map((name) => `${relPath}:${line} names ${name}`)))
    expect(offenders).toEqual([])
  })
})

describe('an external MCP client is never told about a tool the registry does not have', () => {
  it('every registered tool\'s description and input-field descriptions', () => {
    expect(REGISTRY.size).toBeGreaterThan(IN_CANVAS.size)
    const offenders = REGISTRY_TOOLS.flatMap((tool) =>
      phantomsIn(interfaceText(tool), REGISTRY).map((name) => `${tool.name}'s description names ${name}`))
    expect(offenders).toEqual([])
  })
})
