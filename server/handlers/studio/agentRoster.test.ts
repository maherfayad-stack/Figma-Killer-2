/**
 * agentRoster — WS-12 §7/§9 gates, exercised without spawning the real
 * `claude` binary (that verification is manual, reported separately — see
 * `docs/features/agent.md`'s "Subagent roster" section for the transcript).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateStudioAgentRoster } from './agentRoster'
import { studioAgentTools } from '../../ai/tools/studio'

const AGENT_NAMES = [
  'screen-scout',
  'screen-builder',
  'style-surgeon',
  'fidelity-auditor',
  'design-critic',
  'almosafer-ds-expert',
  'synthesizer',
  'agent-creator',
  'system-prompt-expert',
]

const REFERENCE_FILES = [
  'canonical-jsx.md',
  'studio-invariants.md',
  'node-ids-and-writeback.md',
  'studio-tools.md',
  'studio-design-principles.md',
  'project-conventions.md',
]

function write(root: string, relPath: string, contents: string): void {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

function parseFrontmatterTools(md: string): string[] {
  // `[ \t]*`, NOT `\s*` — `\s` matches `\n` too, so a greedy `\s*` on an
  // EMPTY tools line would eat past the line break and swallow the next
  // non-blank line (the closing `---`) into the capture.
  const match = md.match(/^tools:[ \t]*(.*)$/m)
  if (!match || !match[1]!.trim()) return []
  return match[1]!.split(',').map((t) => t.trim()).filter(Boolean)
}

describe('generateStudioAgentRoster', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-roster-'))
    write(dir, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
    write(dir, 'src/pages/Home.tsx', 'export default function Home() { return <div>Hi</div> }\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes exactly the nine-agent roster, once per name', () => {
    const result = generateStudioAgentRoster(dir)
    for (const name of AGENT_NAMES) {
      expect(result.written).toContain(join('.claude', 'agents', `${name}.md`))
    }
    expect(result.written.filter((p) => p.startsWith(join('.claude', 'agents')))).toHaveLength(AGENT_NAMES.length)
  })

  it('writes the six §7.4 reference files', () => {
    const result = generateStudioAgentRoster(dir)
    for (const file of REFERENCE_FILES) {
      expect(result.written).toContain(file)
      expect(existsSync(join(dir, file))).toBe(true)
    }
  })

  // ── Gate 1 (§9): every tool named in an agent definition is a real, ──────
  // ── registered tool. ─────────────────────────────────────────────────────
  it('every generated agent names only tools that exist in studioAgentTools', () => {
    generateStudioAgentRoster(dir)
    const registered = new Set(studioAgentTools.map((t) => t.name))
    for (const name of AGENT_NAMES) {
      const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
      for (const tool of parseFrontmatterTools(md)) {
        expect(registered.has(tool)).toBe(true)
      }
    }
  })

  // ── Gate 2 (§9/§7.3): no generated subagent holds a tool the main agent ──
  // ── lacks — the roster can be subdivided, never escalated. ───────────────
  it('no generated subagent holds a tool outside the main agent\'s own toolset', () => {
    generateStudioAgentRoster(dir)
    const mainToolNames = new Set(studioAgentTools.map((t) => t.name))
    for (const name of AGENT_NAMES) {
      const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
      const tools = parseFrontmatterTools(md)
      expect(tools.every((t) => mainToolNames.has(t))).toBe(true)
    }
  })

  it('every agent frontmatter declares an EXPLICIT tools line — never omitted (the shell/write-tool guard)', () => {
    generateStudioAgentRoster(dir)
    for (const name of AGENT_NAMES) {
      const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
      expect(md).toMatch(/^tools:.*$/m)
    }
  })

  it('the two meta-authoring agents (agent-creator, system-prompt-expert) hold NO tools at all', () => {
    generateStudioAgentRoster(dir)
    for (const name of ['agent-creator', 'system-prompt-expert']) {
      const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
      expect(parseFrontmatterTools(md)).toEqual([])
    }
  })

  it('no generated agent holds a shell or raw file-write tool', () => {
    generateStudioAgentRoster(dir)
    for (const name of AGENT_NAMES) {
      const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
      expect(md).not.toMatch(/\b(Bash|Write|Edit)\b/)
    }
  })

  it('studio-tools.md is generated from the live registry — lists every real tool name', () => {
    generateStudioAgentRoster(dir)
    const content = readFileSync(join(dir, 'studio-tools.md'), 'utf8')
    for (const tool of studioAgentTools) {
      expect(content).toContain(tool.name)
    }
  })

  it('reference files point at the doc, never duplicate its content', () => {
    generateStudioAgentRoster(dir)
    const content = readFileSync(join(dir, 'canonical-jsx.md'), 'utf8')
    expect(content).toContain('docs/reference/canonical-jsx.md')
    // A pointer file stays short — nowhere near the length of the real doc.
    expect(content.length).toBeLessThan(3000)
  })

  it('almosafer-ds-expert degrades honestly when the package is not installed', () => {
    generateStudioAgentRoster(dir)
    const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
    expect(md).toContain('does NOT currently depend on @alm-design/design-system')
  })

  it('almosafer-ds-expert embeds the package\'s own CLAUDE.md/design.md when present', () => {
    write(
      dir,
      '.studio/meta.json',
      JSON.stringify({
        profile: {
          framework: 'vite',
          appRoot: '',
          pagesDir: 'src/pages',
          routeStyle: 'flat',
          entryFiles: [],
          packageManager: 'bun',
          styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
          componentPackages: ['@alm-design/design-system'],
          colorScheme: { mechanism: 'none' },
          aliases: {},
          warnings: [],
        },
      }),
    )
    write(dir, 'node_modules/@alm-design/design-system/CLAUDE.md', '# ALM CLAUDE.md fixture content')
    write(dir, 'node_modules/@alm-design/design-system/design.md', '# ALM design.md fixture content')

    generateStudioAgentRoster(dir)
    const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
    expect(md).toContain('ALM CLAUDE.md fixture content')
    expect(md).toContain('ALM design.md fixture content')
  })

  // ── Regeneration semantics (trap #12) ────────────────────────────────────
  it('a second call with nothing changed writes nothing new', () => {
    generateStudioAgentRoster(dir)
    const second = generateStudioAgentRoster(dir)
    expect(second.written).toHaveLength(0)
    expect(second.skipped).toHaveLength(0)
  })

  it('never overwrites a generated file the user has hand-edited since', () => {
    generateStudioAgentRoster(dir)
    const target = join(dir, '.claude', 'agents', 'screen-scout.md')
    writeFileSync(target, '--- USER EDITED THIS FILE ---\n')

    const second = generateStudioAgentRoster(dir)
    expect(second.skipped).toContain(join('.claude', 'agents', 'screen-scout.md'))
    expect(readFileSync(target, 'utf8')).toBe('--- USER EDITED THIS FILE ---\n')
  })

  it('regenerates a file Studio itself last wrote (content still matches the manifest)', () => {
    generateStudioAgentRoster(dir)
    // Simulate a project probe change (e.g. package manager detected differently)
    // by directly re-running generation with the SAME inputs — content is
    // identical, so this should be a no-op rewrite, not a skip.
    const before = readFileSync(join(dir, 'studio-tools.md'), 'utf8')
    const second = generateStudioAgentRoster(dir)
    expect(second.skipped).not.toContain('studio-tools.md')
    expect(readFileSync(join(dir, 'studio-tools.md'), 'utf8')).toBe(before)
  })

  it('never throws for a directory with no readable project at all', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'studio-roster-empty-'))
    try {
      expect(() => generateStudioAgentRoster(emptyDir)).not.toThrow()
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
