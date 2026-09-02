/**
 * canonicalCheck — one positive + one negative case per rule in
 * `docs/reference/canonical-jsx.md` §2, run against the committed reference
 * fixture (`studio-workspace/__canonical-fixture/`, WS-13 §5) rather than a
 * synthetic tmpdir: that fixture IS the verification target, not a stand-in
 * for one.
 *
 * Assertions are COUNT-based per rule, not line-number-based: line numbers
 * shift every time the fixture is edited, and a count says exactly what this
 * suite promises — "the canonical screen shows none of this finding, the
 * non-canonical screen shows at least one" — without coupling the test to
 * exact source positions.
 *
 * Rule 8 (`static-svg`) is the one exception: its only reachable trigger is
 * >64 KB of serialized markup (see the rule's own doc comment in
 * `canonicalCheck.ts` and its "Validator caveat" in the doc), which is too
 * large to commit as a small, reviewable fixture — so its NEGATIVE case is
 * generated at test time into a throwaway tmpdir instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkCanonicalJsx,
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  summarizeCanonicalFindings,
  CANONICAL_JSX_RULES,
  type CanonicalFinding,
  type CanonicalRuleId,
  type ComponentSource,
  type ParsedPage,
  type StaticEvalOptions,
} from '@core/page-parser'

const FIXTURE_DIR = path.join(import.meta.dir, '..', '..', '..', '..', 'studio-workspace', '__canonical-fixture')

/**
 * A minimal stand-in for `styleCompile.ts`'s real `.module.css` -> class-map
 * transform: finds every selector in each `*.module.css` file under
 * `workspaceRoot` and maps it to itself. Real Studio loads hash the class
 * name; this test only needs `className={styles.x}` to RESOLVE (so rule 6's
 * `static-class-name` signal fires the same way it does for a real CSS
 * Modules import), not the exact hashed value, so reusing the real
 * transform would add a dependency on `server/handlers/studio/styleCompile.ts`
 * for no behavioural difference this suite cares about.
 */
function buildModuleClassMaps(workspaceRoot: string): Record<string, Record<string, string>> {
  const maps: Record<string, Record<string, string>> = {}
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.module.css')) continue
      const rel = path.relative(workspaceRoot, full).split(path.sep).join('/')
      const css = fs.readFileSync(full, 'utf8')
      const classMap: Record<string, string> = {}
      for (const match of css.matchAll(/\.([A-Za-z_][\w-]*)\s*\{/g)) {
        classMap[match[1]!] = match[1]!
      }
      maps[rel] = classMap
    }
  }
  walk(workspaceRoot)
  return maps
}

function evalOptions(workspaceRoot: string): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot, cssModuleClassMaps: buildModuleClassMaps(workspaceRoot) }
}

interface LoadedScreen {
  page: ParsedPage
  sourceText: string
  sources: Record<string, ComponentSource>
}

/** Parses + inlines exactly like `loadStudioPages` does for one page, plus the raw source text `single-styling-mechanism` needs. */
function loadScreen(workspaceRoot: string, relPath: string): LoadedScreen {
  const file = path.join(workspaceRoot, ...relPath.split('/'))
  const project = createWorkspaceProject(workspaceRoot)
  const opts = evalOptions(workspaceRoot)
  const parsed = parsePageFile(file, workspaceRoot, project, opts)
  const sources = resolveComponentSources(project, file, workspaceRoot, parsed)
  const page = inlineLocalComponents(parsed, sources, project, workspaceRoot, { evalOptions: opts })
  return { page, sourceText: fs.readFileSync(file, 'utf8'), sources }
}

function byRule(findings: CanonicalFinding[], ruleId: CanonicalRuleId): CanonicalFinding[] {
  return findings.filter((f) => f.ruleId === ruleId)
}

describe('canonicalCheck — registry', () => {
  it('has exactly the ten rules the WS-13 spec names', () => {
    const ids = CANONICAL_JSX_RULES.map((r) => r.id).sort()
    expect(ids).toEqual(
      [
        'single-return',
        'literal-props',
        'literal-text',
        'const-array-map',
        'no-spread-props',
        'static-class-name',
        'single-styling-mechanism',
        'static-svg',
        'direct-component-imports',
        'no-wrapper-elements',
      ].sort(),
    )
  })

  it('never throws on an empty page', () => {
    expect(() => checkCanonicalJsx({ page: { rootIds: [], nodes: {} } })).not.toThrow()
    expect(checkCanonicalJsx({ page: { rootIds: [], nodes: {} } })).toEqual([])
  })

  it('skips sourceText- and componentSources-dependent rules when omitted, never guesses', () => {
    const { page } = loadScreen(FIXTURE_DIR, 'src/screens/NonCanonicalScreen.tsx')
    const findings = checkCanonicalJsx({ page }) // no sourceText, no componentSources
    expect(byRule(findings, 'single-styling-mechanism')).toEqual([])
    expect(byRule(findings, 'direct-component-imports')).toEqual([])
  })

  // The exact classification a canonical file's zero-findings premise depends
  // on — see `CanonicalTier`'s own doc comment in canonicalCheck.ts. A rule
  // is `'advisory'` only when its underlying signal genuinely cannot tell a
  // permitted shape from a forbidden one, or the check is an admitted
  // heuristic; everything else is `'violation'`.
  it('has the tier every rule\'s own caveat implies', () => {
    const tierById = new Map(CANONICAL_JSX_RULES.map((r) => [r.id, r.tier]))
    expect(tierById.get('single-return')).toBe('violation')
    expect(tierById.get('literal-props')).toBe('advisory')
    expect(tierById.get('literal-text')).toBe('violation')
    expect(tierById.get('const-array-map')).toBe('violation')
    expect(tierById.get('no-spread-props')).toBe('violation')
    expect(tierById.get('static-class-name')).toBe('advisory')
    expect(tierById.get('single-styling-mechanism')).toBe('violation')
    expect(tierById.get('static-svg')).toBe('violation')
    expect(tierById.get('direct-component-imports')).toBe('violation')
    expect(tierById.get('no-wrapper-elements')).toBe('advisory')
  })
})

describe('canonicalCheck — summarizeCanonicalFindings', () => {
  it('a canonical screen is isCanonical despite carrying an advisory finding', () => {
    const { page, sourceText, sources } = loadScreen(FIXTURE_DIR, 'src/screens/CanonicalScreen.tsx')
    const findings = checkCanonicalJsx({ page, sourceText, componentSources: sources })
    const summary = summarizeCanonicalFindings(findings)
    // CanonicalScreen's root <section className={styles.hero}> is a
    // deliberate, expected `static-class-name` advisory (see the rule-6
    // test above) — it must not make the file look non-canonical.
    expect(summary.advisories).toBeGreaterThan(0)
    expect(summary.violations).toBe(0)
    expect(summary.isCanonical).toBe(true)
  })

  it('a non-canonical screen is not isCanonical', () => {
    const { page, sourceText, sources } = loadScreen(FIXTURE_DIR, 'src/screens/NonCanonicalScreen.tsx')
    const findings = checkCanonicalJsx({ page, sourceText, componentSources: sources })
    const summary = summarizeCanonicalFindings(findings)
    expect(summary.violations).toBeGreaterThan(0)
    expect(summary.isCanonical).toBe(false)
    expect(summary.violations + summary.advisories).toBe(findings.length)
  })

  it('every finding carries the tier its own rule is registered with', () => {
    const { page, sourceText, sources } = loadScreen(FIXTURE_DIR, 'src/screens/NonCanonicalScreen.tsx')
    const findings = checkCanonicalJsx({ page, sourceText, componentSources: sources })
    const tierById = new Map(CANONICAL_JSX_RULES.map((r) => [r.id, r.tier]))
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.tier).toBe(tierById.get(f.ruleId))
    }
  })
})

describe('canonicalCheck — CanonicalScreen.tsx (positive)', () => {
  let findings: CanonicalFinding[]

  beforeEach(() => {
    const { page, sourceText, sources } = loadScreen(FIXTURE_DIR, 'src/screens/CanonicalScreen.tsx')
    findings = checkCanonicalJsx({ page, sourceText, componentSources: sources })
  })

  it('rule 1 — no auto-selected branch (single, unconditional return)', () => {
    expect(byRule(findings, 'single-return')).toEqual([])
  })

  it('rule 2 — every prop is a literal (design-system props, .map rows excluded)', () => {
    expect(byRule(findings, 'literal-props')).toEqual([])
  })

  it('rule 3 — every text node is a literal (the heading; a .map row\'s item text is excluded)', () => {
    expect(byRule(findings, 'literal-text')).toEqual([])
  })

  it('rule 4 — .map over PLANS resolves cleanly, no unresolved dynamic content', () => {
    expect(byRule(findings, 'const-array-map')).toEqual([])
  })

  it('rule 5 — no spread props anywhere', () => {
    expect(byRule(findings, 'no-spread-props')).toEqual([])
  })

  it('rule 6 — styles.x still reports, as an ADVISORY (documented, expected): exactly the hero section, not the svg\'s literal className or the .map row', () => {
    const classNameFindings = byRule(findings, 'static-class-name')
    expect(classNameFindings).toHaveLength(1)
    expect(classNameFindings[0]!.tier).toBe('advisory')
    const rootId = loadScreen(FIXTURE_DIR, 'src/screens/CanonicalScreen.tsx').page.rootIds[0]
    expect(classNameFindings[0]!.nodeId).toBe(rootId)
  })

  it('rule 7 — only plain CSS and a CSS Module are imported', () => {
    expect(byRule(findings, 'single-styling-mechanism')).toEqual([])
  })

  it('rule 8 — the inline <svg> is static and serializes', () => {
    expect(byRule(findings, 'static-svg')).toEqual([])
  })

  it('rule 9 — Button (package) and PlanCard (local) both resolve', () => {
    expect(byRule(findings, 'direct-component-imports')).toEqual([])
  })

  it('rule 10 — no unnecessary single-child wrapper', () => {
    expect(byRule(findings, 'no-wrapper-elements')).toEqual([])
  })
})

describe('canonicalCheck — NonCanonicalScreen.tsx (negative)', () => {
  let findings: CanonicalFinding[]

  beforeEach(() => {
    const { page, sourceText, sources } = loadScreen(FIXTURE_DIR, 'src/screens/NonCanonicalScreen.tsx')
    findings = checkCanonicalJsx({ page, sourceText, componentSources: sources })
  })

  it('rule 1 — Math.random() is never statically decidable, so a branch is auto-selected', () => {
    expect(byRule(findings, 'single-return').length).toBeGreaterThan(0)
  })

  it('rule 2 — PLANS[0].name is a computed access, not a literal or a bare const', () => {
    expect(byRule(findings, 'literal-props').length).toBeGreaterThan(0)
  })

  it('rule 3 — the same computed access used as text', () => {
    expect(byRule(findings, 'literal-text').length).toBeGreaterThan(0)
  })

  it('rule 4 — .map over an unresolvable call locks as dynamic content', () => {
    expect(byRule(findings, 'const-array-map').length).toBeGreaterThan(0)
  })

  it('rule 5 — the spread attribute', () => {
    expect(byRule(findings, 'no-spread-props').length).toBeGreaterThan(0)
  })

  it('rule 6 — a className bound to a const identifier (neither literal nor styles.x)', () => {
    expect(byRule(findings, 'static-class-name').length).toBeGreaterThan(0)
  })

  it('rule 7 — imports a .scss stylesheet', () => {
    expect(byRule(findings, 'single-styling-mechanism').length).toBeGreaterThan(0)
  })

  it('rule 9 — <UndeclaredWidget/> traces to no import and no same-file declaration', () => {
    expect(byRule(findings, 'direct-component-imports').length).toBeGreaterThan(0)
  })

  it('rule 10 — the pointless single-child wrapper', () => {
    expect(byRule(findings, 'no-wrapper-elements').length).toBeGreaterThan(0)
  })

  it('findings are sorted by source position', () => {
    for (let i = 1; i < findings.length; i++) {
      const prev = findings[i - 1]!
      const cur = findings[i]!
      const prevKey = `${prev.file}:${String(prev.line).padStart(8, '0')}:${String(prev.col).padStart(8, '0')}`
      const curKey = `${cur.file}:${String(cur.line).padStart(8, '0')}:${String(cur.col).padStart(8, '0')}`
      expect(prevKey <= curKey).toBe(true)
    }
  })
})

describe('canonicalCheck — rule 8 (static-svg), synthetic negative', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-svg-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('an oversized inline <svg> (>64 KB serialized) cannot be serialized and is flagged', () => {
    const oversizedAttr = 'A'.repeat(70_000)
    const file = path.join(tmpDir, 'OversizedSvg.tsx')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        'export default function OversizedSvg() {',
        '  return (',
        '    <svg viewBox="0 0 10 10">',
        `      <circle data-blob="${oversizedAttr}" cx="1" cy="1" r="1" />`,
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const { page } = loadScreen(tmpDir, 'OversizedSvg.tsx')
    const findings = checkCanonicalJsx({ page })
    expect(byRule(findings, 'static-svg').length).toBeGreaterThan(0)
  })

  it('an ordinary static <svg> is never flagged', () => {
    const file = path.join(tmpDir, 'PlainSvg.tsx')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        'export default function PlainSvg() {',
        '  return (',
        '    <svg viewBox="0 0 10 10">',
        '      <circle cx="1" cy="1" r="1" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const { page } = loadScreen(tmpDir, 'PlainSvg.tsx')
    const findings = checkCanonicalJsx({ page })
    expect(byRule(findings, 'static-svg')).toEqual([])
  })
})

/**
 * Doc <-> registry parity gate, in the same spirit as
 * `server/ai/mcp/tools/studio/fidelityCodes.test.ts`: every rule id in
 * `CANONICAL_JSX_RULES` must be documented in `docs/reference/canonical-jsx.md`,
 * and every rule id the doc names as a section heading must be a real
 * registered rule, so the spec and the code cannot drift apart.
 */
describe('canonicalCheck — doc parity', () => {
  const DOC_PATH = path.join(import.meta.dir, '..', '..', '..', '..', 'docs', 'reference', 'canonical-jsx.md')

  function extractDocRuleIds(doc: string): Set<string> {
    const ids = new Set<string>()
    for (const match of doc.matchAll(/^### \d+\. `([a-z-]+)`/gm)) {
      ids.add(match[1]!)
    }
    return ids
  }

  /**
   * Each rule section is `### N. \`rule-id\` — …`, a blank line, then
   * `**Tier:** violation|advisory` (optionally followed by ` — …` prose) —
   * see the doc's own rule sections. Anchored to the heading immediately
   * above it, so a doc section with no `**Tier:**` line at all is absent
   * from the map (and fails the "every rule has a doc tier" test below,
   * rather than silently matching a DIFFERENT section's tier).
   */
  function extractDocRuleTiers(doc: string): Map<string, string> {
    const tiers = new Map<string, string>()
    for (const match of doc.matchAll(/^### \d+\. `([a-z-]+)`[^\n]*\n\n\*\*Tier:\*\*\s+(violation|advisory)\b/gm)) {
      tiers.set(match[1]!, match[2]!)
    }
    return tiers
  }

  it('finds the doc', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true)
  })

  it('every registered rule id has a numbered section in the doc', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    const docIds = extractDocRuleIds(doc)
    for (const rule of CANONICAL_JSX_RULES) {
      expect(docIds.has(rule.id)).toBe(true)
    }
  })

  it('every numbered rule heading in the doc is a registered rule id', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    const docIds = extractDocRuleIds(doc)
    const registered = new Set(CANONICAL_JSX_RULES.map((r) => r.id))
    for (const id of docIds) {
      expect(registered.has(id)).toBe(true)
    }
  })

  it('every registered rule states its tier in the doc, and the two agree', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8')
    const docTiers = extractDocRuleTiers(doc)
    for (const rule of CANONICAL_JSX_RULES) {
      expect(docTiers.has(rule.id)).toBe(true)
      expect(docTiers.get(rule.id)).toBe(rule.tier)
    }
  })

  it('has no duplicate rule ids', () => {
    const ids = CANONICAL_JSX_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
