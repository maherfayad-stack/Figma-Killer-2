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
  'arabic-ux-writer',
  'almosafer-ds-expert',
  'synthesizer',
  'agent-creator',
  'system-prompt-expert',
]

// Every reference file lands under `.claude/` (not the project root) — see
// agentRoster.ts's own "Reference files live IN .claude/" doc comment.
const REFERENCE_FILES = [
  '.claude/canonical-jsx.md',
  '.claude/studio-invariants.md',
  '.claude/node-ids-and-writeback.md',
  '.claude/studio-tools.md',
  '.claude/studio-design-principles.md',
  '.claude/project-conventions.md',
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
    // See agentRosterFigma.test.ts: opt out of the auto-approved loopback
    // `figma` built-in so these assert on the fixture, not on the default.
    write(dir, '.studio/meta.json', JSON.stringify({ disabledBuiltInMcpServers: ['figma'] }))
    write(dir, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
    write(dir, 'src/pages/Home.tsx', 'export default function Home() { return <div>Hi</div> }\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes exactly the ten-agent roster, once per name', () => {
    const result = generateStudioAgentRoster(dir)
    for (const name of AGENT_NAMES) {
      expect(result.written).toContain(join('.claude', 'agents', `${name}.md`))
    }
    expect(result.written.filter((p) => p.startsWith(join('.claude', 'agents')))).toHaveLength(AGENT_NAMES.length)
  })

  it('writes the six §7.4 reference files under .claude/, not the project root', () => {
    const result = generateStudioAgentRoster(dir)
    for (const file of REFERENCE_FILES) {
      expect(result.written).toContain(file)
      expect(existsSync(join(dir, ...file.split('/')))).toBe(true)
    }
    // The bug this closes: a bare-name write at the project root, which every
    // prompt's own "(in this same .claude/ directory)" wording contradicted.
    for (const file of REFERENCE_FILES) {
      const bareName = file.split('/').pop()!
      expect(existsSync(join(dir, bareName))).toBe(false)
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
    const content = readFileSync(join(dir, '.claude', 'studio-tools.md'), 'utf8')
    for (const tool of studioAgentTools) {
      expect(content).toContain(tool.name)
    }
  })

  it('reference files point at the doc, never duplicate its content', () => {
    generateStudioAgentRoster(dir)
    const content = readFileSync(join(dir, '.claude', 'canonical-jsx.md'), 'utf8')
    expect(content).toContain('docs/reference/canonical-jsx.md')
    // A pointer file stays short — nowhere near the length of the real doc.
    expect(content.length).toBeLessThan(3000)
  })

  // ── arabic-ux-writer (WS-12 §7.2 peer) ───────────────────────────────────
  it('arabic-ux-writer holds an explicit text-editing + node-location allowlist, no structural or write-adjacent tool', () => {
    generateStudioAgentRoster(dir)
    const md = readFileSync(join(dir, '.claude', 'agents', 'arabic-ux-writer.md'), 'utf8')
    expect(parseFrontmatterTools(md)).toEqual([
      'studio_list_pages',
      'studio_find_nodes',
      'studio_get_node_source',
      'studio_read_file',
      'studio_apply_edits',
    ])
    // No orientation/structural/toolchain tool leaked in — this agent locates
    // and rewrites text, it never scaffolds, installs, or verifies renders.
    for (const forbidden of ['studio_create_page', 'studio_codemod', 'studio_set_frames', 'studio_install_deps', 'studio_install_status']) {
      expect(md).not.toContain(forbidden)
    }
  })

  it('arabic-ux-writer names its two dominant failure modes and points at the RTL fidelity finding rather than editing layout', () => {
    generateStudioAgentRoster(dir)
    const md = readFileSync(join(dir, '.claude', 'agents', 'arabic-ux-writer.md'), 'utf8')
    expect(md).toContain('عرنجي')
    expect(md).toContain('RTL_PHYSICAL_PROPERTY')
    expect(md).toContain('فصحى مبسطة')
  })

  it('almosafer-ds-expert degrades honestly when there is no design system at all', () => {
    generateStudioAgentRoster(dir)
    const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
    expect(md).toContain('does NOT currently depend on @alm-design/design-system')
  })

  // ── design-system.md — the seventh reference file (decoupled from node_modules) ──
  it('does not write design-system.md when the project has no design system at all', () => {
    const result = generateStudioAgentRoster(dir)
    expect(result.written).not.toContain('.claude/design-system.md')
    expect(existsSync(join(dir, '.claude', 'design-system.md'))).toBe(false)
  })

  it('writes design-system.md from a styles/imported/<slug>/ CSS copy — no package.json, no node_modules, no CLAUDE.md anywhere', () => {
    write(dir, 'styles/imported/alm-design-design-system-1-1-3/src/tokens/rounded.css', ':root { --rounded-sm: 8px; }')
    write(dir, 'styles/imported/alm-design-design-system-1-1-3/src/components/Button.css', '.btn { display: flex; } .btn--primary { color: red; }')

    const result = generateStudioAgentRoster(dir)
    expect(result.written).toContain('.claude/design-system.md')
    const digest = readFileSync(join(dir, '.claude', 'design-system.md'), 'utf8')
    expect(digest).toContain('## Radius (1 tokens)')
    expect(digest).toContain('.btn — variants: --primary')

    // almosafer-ds-expert points at it instead of saying "nothing to consult".
    const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
    expect(md).toContain('.claude/design-system.md')
    expect(md).not.toContain('does NOT currently depend on @alm-design/design-system')
  })

  // ── mcp-tooling: a vetted MCP-namespaced tool + the project-conditional ──
  // ── figma-asset-scout subagent + figma.md reference file. ────────────────
  describe('figma-asset-scout and figma.md — generated only for an approved Figma-capable MCP server', () => {
    function approveFigmaServer(): void {
      write(dir, '.mcp.json', JSON.stringify({ mcpServers: { figma: { command: 'npx', args: ['figma-mcp'] } } }))
      write(dir, '.studio/meta.json', JSON.stringify({ disabledBuiltInMcpServers: ['figma'], approvedMcpServers: ['figma'] }))
    }

    it('generates neither figma-asset-scout nor figma.md when no MCP server is approved', () => {
      const result = generateStudioAgentRoster(dir)
      expect(existsSync(join(dir, '.claude', 'agents', 'figma-asset-scout.md'))).toBe(false)
      expect(existsSync(join(dir, '.claude', 'figma.md'))).toBe(false)
      expect(result.written).not.toContain('.claude/figma.md')
    })

    it('does NOT generate figma-asset-scout for a DECLARED but unapproved Figma server — approval is required, not just presence', () => {
      write(dir, '.mcp.json', JSON.stringify({ mcpServers: { figma: { command: 'npx', args: ['figma-mcp'] } } }))
      generateStudioAgentRoster(dir)
      expect(existsSync(join(dir, '.claude', 'agents', 'figma-asset-scout.md'))).toBe(false)
    })

    it('generates figma-asset-scout + figma.md once a Figma-capable server is approved', () => {
      approveFigmaServer()
      const result = generateStudioAgentRoster(dir)
      expect(result.written).toContain(join('.claude', 'agents', 'figma-asset-scout.md'))
      expect(result.written).toContain('.claude/figma.md')

      const agentMd = readFileSync(join(dir, '.claude', 'agents', 'figma-asset-scout.md'), 'utf8')
      expect(parseFrontmatterTools(agentMd)).toEqual([
        'studio_read_file',
        'studio_list_component_bindings',
        'studio_find_component',
        'studio_fetch_remote_asset',
        'mcp__figma__get_metadata',
        'mcp__figma__get_image',
      ])
      // No shell/write-adjacent/structural tool leaked in.
      expect(agentMd).not.toMatch(/\b(Bash|Write|Edit)\b/)
      expect(agentMd).not.toContain('studio_apply_edits')

      const referenceMd = readFileSync(join(dir, '.claude', 'figma.md'), 'utf8')
      expect(referenceMd).toContain('studio_list_component_bindings')
      expect(referenceMd).toContain('nodeIdPlaceholder')
    })

    it('every tool named in figma-asset-scout passes the SAME vetting gate 1 already checks for the base ten agents', () => {
      approveFigmaServer()
      generateStudioAgentRoster(dir)
      const registered = new Set(studioAgentTools.map((t) => t.name))
      const agentMd = readFileSync(join(dir, '.claude', 'agents', 'figma-asset-scout.md'), 'utf8')
      for (const tool of parseFrontmatterTools(agentMd)) {
        // A vetted tool is EITHER a real native tool OR a vetted mcp__ name —
        // never something this project has no honest claim to.
        const isNative = registered.has(tool)
        const isVettedMcp = tool.startsWith('mcp__figma__')
        expect(isNative || isVettedMcp).toBe(true)
      }
    })

    it('approving a server after an unchanged first run still forces a full regeneration, not the fast path — the fingerprint gate must see approval state', () => {
      const first = generateStudioAgentRoster(dir)
      expect(first.written.length).toBeGreaterThan(0)
      const unchanged = generateStudioAgentRoster(dir)
      expect(unchanged.written).toHaveLength(0)

      approveFigmaServer()
      const afterApproval = generateStudioAgentRoster(dir)
      expect(afterApproval.written).toContain(join('.claude', 'agents', 'figma-asset-scout.md'))
    })

    it('never lets an approved but non-Figma server (e.g. the design-system MCP) spawn figma-asset-scout', () => {
      write(dir, '.mcp.json', JSON.stringify({ mcpServers: { 'design-system': { command: 'design-system-mcp' } } }))
      write(dir, '.studio/meta.json', JSON.stringify({ disabledBuiltInMcpServers: ['figma'], approvedMcpServers: ['design-system'] }))
      generateStudioAgentRoster(dir)
      expect(existsSync(join(dir, '.claude', 'agents', 'figma-asset-scout.md'))).toBe(false)
    })
  })

  // ── defect 1: the 50 KB whole-file cap silently dropped the real, ────────
  // ── correctly-installed package's docs — fixed by an outline instead. ────
  describe('almosafer-ds-expert embeds an OUTLINE of the package docs, never the whole file', () => {
    function writeAlmProfile(): void {
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
    }

    it('lists headings and byte sizes, and points the agent at studio_read_package_doc instead of embedding bodies', () => {
      writeAlmProfile()
      write(
        dir,
        'node_modules/@alm-design/design-system/CLAUDE.md',
        '# CLAUDE.md\n\n## Button\n\nButton props: variant, size, dir.\n\n## Card\n\nCard body text describing the component in more depth than a heading alone.\n',
      )
      write(
        dir,
        'node_modules/@alm-design/design-system/design.md',
        '# design.md\n\n## Voice\n\nDesign voice and content guidance goes here.\n',
      )

      generateStudioAgentRoster(dir)
      const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')

      expect(md).toContain('studio_read_package_doc')
      expect(md).toContain('Button')
      expect(md).toContain('Card')
      expect(md).toContain('Voice')
      // The outline names headings and sizes — the BODY text is never embedded.
      expect(md).not.toContain('Button props: variant, size, dir.')
      expect(md).not.toContain('Card body text describing the component')
      expect(md).not.toContain('Design voice and content guidance goes here.')
    })

    it('still embeds a usable outline for files well past the old 50 KB whole-file cap — the exact defect this closes', () => {
      writeAlmProfile()
      // A single ~60 KB section, comfortably over the retired DS_FILE_MAX_BYTES
      // cap that used to make `readTextCapped` return `undefined` here.
      const bigBody = 'Lorem ipsum dolor sit amet. '.repeat(2200) // ~62,700 bytes
      write(dir, 'node_modules/@alm-design/design-system/CLAUDE.md', `# CLAUDE.md\n\n## Everything\n\n${bigBody}\n`)
      write(dir, 'node_modules/@alm-design/design-system/design.md', '# design.md\n\n## Voice\n\nShort.\n')

      generateStudioAgentRoster(dir)
      const md = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')

      // Would have fallen into the "nothing to consult" branch under the old cap.
      expect(md).not.toContain('does NOT currently depend on @alm-design/design-system')
      expect(md).toContain('Everything')
      expect(md).toContain('studio_read_package_doc')
      // The outline reports a real size close to the source — proof it read
      // the whole file to build the outline, not just the first 50 KB.
      expect(md).toMatch(/Everything \(6\d,\d{3} bytes\)/)
    })
  })

  // ── defect 3 / design-system-first: real tools, priority order ───────────
  describe('design-system-first tool grants and guidance', () => {
    it('screen-builder, style-surgeon, and almosafer-ds-expert all hold the real catalog tools', () => {
      generateStudioAgentRoster(dir)
      for (const name of ['screen-builder', 'style-surgeon', 'almosafer-ds-expert']) {
        const md = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
        const tools = parseFrontmatterTools(md)
        expect(tools).toContain('studio_list_components')
        expect(tools).toContain('studio_find_component')
      }
    })

    it('screen-builder is told to check the catalog before composing and never told to call a tool it does not hold', () => {
      generateStudioAgentRoster(dir)
      const md = readFileSync(join(dir, '.claude', 'agents', 'screen-builder.md'), 'utf8')
      expect(md).toContain('studio_list_components')
      expect(md).toContain('Before composing anything')
      // The old, broken guidance named bare `list_components`/`find_component`
      // as if they were tools screen-builder held — it never held either.
      expect(md).not.toMatch(/[^_]list_components/)
      expect(md).not.toMatch(/[^_]find_component/)
    })

    it('studio-design-principles.md names the real Studio tools first, explains the design-system-MCP alternative as an upgrade (never as a substitute Studio itself lacks), and never leaves an empty catalog unexplained', () => {
      generateStudioAgentRoster(dir)
      const md = readFileSync(join(dir, '.claude', 'studio-design-principles.md'), 'utf8')
      expect(md).toContain('studio_list_components')
      expect(md).toContain('studio_find_component')
      // The design-system's OWN MCP server route is named too, but only ever
      // qualified as "when approved" / "ITS" — never presented as a tool this
      // agent already holds under a bare name.
      expect(md).toContain('approvedMcpServers')
      expect(md).toMatch(/ITS `list_components`\/`find_component`/)
      expect(md).toContain('EMPTY result')
    })
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
    const before = readFileSync(join(dir, '.claude', 'studio-tools.md'), 'utf8')
    const second = generateStudioAgentRoster(dir)
    expect(second.skipped).not.toContain('.claude/studio-tools.md')
    expect(readFileSync(join(dir, '.claude', 'studio-tools.md'), 'utf8')).toBe(before)
  })

  it('never throws for a directory with no readable project at all', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'studio-roster-empty-'))
    try {
      expect(() => generateStudioAgentRoster(emptyDir)).not.toThrow()
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  // ── perf-06: the fingerprint/stat gate — must speed up the warm path ─────
  // ── WITHOUT weakening the never-clobber-a-user-edit contract above. ──────
  describe('regeneration fingerprint gate (perf-06)', () => {
    it('a hand edit is still detected on the very next call even though nothing else changed (the fingerprint alone would miss it)', () => {
      generateStudioAgentRoster(dir)
      const target = join(dir, '.claude', 'agents', 'screen-scout.md')
      writeFileSync(target, '--- USER EDITED THIS FILE ---\n')

      // The project/roster inputs are IDENTICAL to the first call — only an
      // OUTPUT file changed. A gate keyed on the input fingerprint alone
      // would see "nothing changed" and never even look at this file.
      const second = generateStudioAgentRoster(dir)
      expect(second.skipped).toContain(join('.claude', 'agents', 'screen-scout.md'))
      expect(readFileSync(target, 'utf8')).toBe('--- USER EDITED THIS FILE ---\n')
    })

    it('once a hand edit has been observed and recorded, a further identical call goes quiet (fast path) without touching the file again', () => {
      generateStudioAgentRoster(dir)
      const target = join(dir, '.claude', 'agents', 'screen-scout.md')
      writeFileSync(target, '--- USER EDITED THIS FILE ---\n')

      const second = generateStudioAgentRoster(dir)
      expect(second.skipped).toContain(join('.claude', 'agents', 'screen-scout.md'))

      // Third call: nothing has changed since the second call recorded this
      // file's current (hand-edited) state — the fast path applies, and the
      // file is neither touched nor re-reported.
      const third = generateStudioAgentRoster(dir)
      expect(third.written).toHaveLength(0)
      expect(third.skipped).toHaveLength(0)
      expect(readFileSync(target, 'utf8')).toBe('--- USER EDITED THIS FILE ---\n')
    })

    it('a persisted profile change (e.g. a completed install) forces a full regeneration, not the fast path', () => {
      generateStudioAgentRoster(dir)
      const before = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
      expect(before).toContain('does NOT currently depend on @alm-design/design-system')

      // Simulate `installDeps.ts` healing the cache after an install: the
      // persisted profile now lists the ALM package, and its docs exist.
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
      write(dir, 'node_modules/@alm-design/design-system/CLAUDE.md', '# fresh CLAUDE.md after install\n\n## Fresh\n\nBody.\n')
      write(dir, 'node_modules/@alm-design/design-system/design.md', '# fresh design.md after install\n\n## Fresh\n\nBody.\n')

      const second = generateStudioAgentRoster(dir)
      expect(second.written).toContain(join('.claude', 'agents', 'almosafer-ds-expert.md'))
      const after = readFileSync(join(dir, '.claude', 'agents', 'almosafer-ds-expert.md'), 'utf8')
      expect(after).toContain('fresh CLAUDE.md after install')
    })

    it('a new design-system CSS file forces a full regeneration of design-system.md, not just a skip', () => {
      write(dir, 'styles/imported/ds/tokens.css', ':root { --rounded-sm: 4px; }')
      generateStudioAgentRoster(dir)
      const before = readFileSync(join(dir, '.claude', 'design-system.md'), 'utf8')
      expect(before).not.toContain('space-sm')

      write(dir, 'styles/imported/ds/spacing.css', ':root { --space-sm: 8px; }')
      const second = generateStudioAgentRoster(dir)
      expect(second.written).toContain('.claude/design-system.md')
      const after = readFileSync(join(dir, '.claude', 'design-system.md'), 'utf8')
      expect(after).toContain('space-sm')
    })

    it('a pre-perf-06 manifest (flat relPath->hash map, no fingerprint/files split) is read as empty rather than crashing, and never clobbers what it can no longer recognise', () => {
      generateStudioAgentRoster(dir)
      const manifestPath = join(dir, '.claude', '.studio-generated.json')
      const oldFlatShape: Record<string, string> = {}
      for (const name of AGENT_NAMES) oldFlatShape[join('.claude', 'agents', `${name}.md`)] = 'not-a-real-hash'
      writeFileSync(manifestPath, JSON.stringify(oldFlatShape))

      const result = generateStudioAgentRoster(dir)
      // Every already-matching Studio-authored file is now "unrecognised" by
      // the old-shaped manifest — treated exactly like a file Studio never
      // wrote before: left alone and reported skipped, never clobbered.
      expect(result.written).toHaveLength(0)
      expect(result.skipped.length).toBeGreaterThan(0)
      for (const name of AGENT_NAMES) {
        const content = readFileSync(join(dir, '.claude', 'agents', `${name}.md`), 'utf8')
        expect(content).toContain(`name: ${name}`)
      }
    })
  })
})
