/**
 * studioCss — §6 round-trip: a fixture workspace's `.css` files become
 * `StyleRule`s, and a page's literal `className` becomes `classIds` pointing
 * at them.
 *
 * The load path is exercised through `loadStudioPages` rather than
 * `loadStudioStyles` directly, because the thing worth protecting is the
 * end-to-end contract the client depends on: rules exist, node `classIds`
 * reference them, ids are identical across two independent loads, and
 * `className` never survives as a prop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPages } from '../studioPageLoad'
import { classIdsForClassName, styleRuleId } from '../studioCss'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-css-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** A workspace with one page, one component, and a stylesheet for each. */
function writeFixtureWorkspace(): void {
  write('pages/Home.css', '.hero { display: flex; gap: 8px }\n.hero__title { font-size: 24px }\nh1 { margin: 0 }\n')
  write('components/Badge.css', '.badge { border-radius: 4px }\n')
  write(
    'components/Badge.tsx',
    ["import './Badge.css'", 'export default function Badge() {', '  return <span className="badge">New</span>', '}', ''].join('\n'),
  )
  write(
    'pages/Home.tsx',
    [
      "import Badge from '../components/Badge'",
      "import './Home.css'",
      'export default function Home() {',
      '  return (',
      '    <div className="hero">',
      '      <h1 className="hero__title">Hi</h1>',
      '      <Badge />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
}

describe('studioCss — imported CSS becomes style rules and classIds', () => {
  it('parses every imported stylesheet, including a locally-inlined component own CSS', async () => {
    writeFixtureWorkspace()

    const { styleRules } = await loadStudioPages(tmpDir)
    const byName = Object.fromEntries(Object.values(styleRules).map((r) => [r.name, r]))

    expect(byName.hero).toMatchObject({ kind: 'class', styles: { display: 'flex', gap: '8px' } })
    expect(byName['hero__title']).toMatchObject({ kind: 'class' })
    // The component's own stylesheet is collected too — after inlining, its
    // markup IS the page's markup. (The CSSOM expands the `border-radius`
    // shorthand into its four longhands, as it does in a browser.)
    expect(byName.badge).toMatchObject({ kind: 'class', styles: { borderTopLeftRadius: '4px' } })
    // A bare element selector is an ambient rule: emitted, but not attachable.
    expect(byName.h1).toMatchObject({ kind: 'ambient', selector: 'h1' })
  })

  it('turns a literal className into classIds and drops the prop', async () => {
    writeFixtureWorkspace()

    const { pages, styleRules } = await loadStudioPages(tmpDir)
    const nodes = Object.values(pages[0]!.nodes)

    const hero = nodes.find((n) => n.classIds.includes(styleRuleId('class', 'hero', 'pages/Home.css')))
    expect(hero).toBeDefined()
    expect(styleRules[hero!.classIds[0]!]!.name).toBe('hero')

    // `className` renders nothing in this engine — it must not linger as a
    // dead value in the properties panel.
    expect(nodes.some((n) => 'className' in n.props)).toBe(false)
  })

  it('assigns identical ids across two independent loads, so reloads do not churn selection', async () => {
    writeFixtureWorkspace()

    const first = await loadStudioPages(tmpDir)
    const second = await loadStudioPages(tmpDir)

    expect(Object.keys(second.styleRules).sort()).toEqual(Object.keys(first.styleRules).sort())
    const classIdsOf = (r: Awaited<ReturnType<typeof loadStudioPages>>): string[][] =>
      Object.values(r.pages[0]!.nodes).map((n) => n.classIds)
    expect(classIdsOf(second)).toEqual(classIdsOf(first))
  })

  it('returns empty styles for a workspace with no stylesheet imports', async () => {
    write('pages/Home.tsx', ['export default function Home() {', '  return <div className="hero" />', '}', ''].join('\n'))

    const { styleRules, conditions, pages } = await loadStudioPages(tmpDir)

    expect(styleRules).toEqual({})
    expect(conditions).toEqual([])
    // No rule to point at, so no dangling classId is invented.
    expect(Object.values(pages[0]!.nodes).every((n) => n.classIds.length === 0)).toBe(true)
  })

  it('records an unmatched @media as a reusable condition rather than dropping it', async () => {
    write('pages/Home.css', '.hero { color: red }\n@media (max-width: 600px) { .hero { color: blue } }\n')
    write(
      'pages/Home.tsx',
      ["import './Home.css'", 'export default function Home() {', '  return <div className="hero" />', '}', ''].join('\n'),
    )

    const { conditions } = await loadStudioPages(tmpDir)

    expect(conditions).toHaveLength(1)
    expect(JSON.stringify(conditions[0]!.condition)).toContain('max-width')
  })
})

/**
 * `panel-02` (WS-6.3) — `styleRuleSources`, the `StyleRule.id -> (file,
 * selector)` map the CSS write-back path (`studioWriteback.ts`'s `css` edit
 * kind) reads at save time. This is the thing that used to not exist at all
 * — `panel-01` shipped the write PRIMITIVE fully tested in isolation, but
 * nothing computed which file a given rule id should write to.
 */
describe('studioCss — styleRuleSources (WS-6.3 write-back mapping)', () => {
  it('maps a class rule to the real .css file and selector it was parsed from', async () => {
    writeFixtureWorkspace()

    const { styleRules, styleRuleSources } = await loadStudioPages(tmpDir)
    const heroId = styleRuleId('class', 'hero', 'pages/Home.css')

    expect(styleRules[heroId]).toBeDefined()
    expect(styleRuleSources[heroId]).toEqual({ file: 'pages/Home.css', selector: '.hero' })
  })

  it('maps an ambient (non-class) rule too — setDeclaration matches by selector, not by kind', async () => {
    writeFixtureWorkspace()

    const { styleRuleSources } = await loadStudioPages(tmpDir)
    const h1Id = styleRuleId('ambient', 'h1', 'pages/Home.css')

    expect(styleRuleSources[h1Id]).toEqual({ file: 'pages/Home.css', selector: 'h1' })
  })

  it('maps a component-owned stylesheet to the component file, not the page that inlined it', async () => {
    writeFixtureWorkspace()

    const { styleRuleSources } = await loadStudioPages(tmpDir)
    const badgeId = styleRuleId('class', 'badge', 'components/Badge.css')

    expect(styleRuleSources[badgeId]).toEqual({ file: 'components/Badge.css', selector: '.badge' })
  })

  it('maps a .module.css class back to its file and its PRE-HASH local selector', async () => {
    write('pages/Home.module.css', '.title { color: red }\n')
    write(
      'pages/Home.tsx',
      [
        "import styles from './Home.module.css'",
        'export default function Home() {',
        '  return <h1 className={styles.title}>Hi</h1>',
        '}',
        '',
      ].join('\n'),
    )

    const { styleRuleSources } = await loadStudioPages(tmpDir)

    // The registry holds the rule under its COMPILED name (`Home_title__…`),
    // because that is what the canvas renders. Its source must nonetheless be
    // the hand-authored file and the selector as written there — `.title`,
    // never the hash. Without this inverse mapping the rule is unmapped, which
    // is what surfaced as "Style not saved to source".
    const moduleSources = Object.values(styleRuleSources).filter((s) => s.file.endsWith('.module.css'))
    expect(moduleSources).toEqual([{ file: 'pages/Home.module.css', selector: '.title' }])
  })

  it('two REAL .css files defining the same class name each get their own id and source (Track B1 fix, S3d)', async () => {
    write('pages/Home.css', '.hero { color: red }\n')
    write('pages/Override.css', '.hero { color: blue }\n')
    write(
      'pages/Home.tsx',
      [
        "import './Home.css'",
        "import './Override.css'",
        'export default function Home() {',
        '  return <div className="hero" />',
        '}',
        '',
      ].join('\n'),
    )

    const { styleRules, styleRuleSources, pages } = await loadStudioPages(tmpDir)
    const homeHeroId = styleRuleId('class', 'hero', 'pages/Home.css')
    const overrideHeroId = styleRuleId('class', 'hero', 'pages/Override.css')

    // The EARLIER file's block is no longer silently destroyed — both rules
    // exist in the registry, each with its own honest write-back source.
    expect(styleRules[homeHeroId]).toMatchObject({ styles: { color: 'red' } })
    expect(styleRules[overrideHeroId]).toMatchObject({ styles: { color: 'blue' } })
    expect(styleRuleSources[homeHeroId]).toEqual({ file: 'pages/Home.css', selector: '.hero' })
    expect(styleRuleSources[overrideHeroId]).toEqual({ file: 'pages/Override.css', selector: '.hero' })

    // For RENDERING, the class name still resolves to exactly one id — the
    // later-parsed file wins, matching cascade order closely enough for the
    // canvas — so a node's classIds stay unambiguous.
    const nodes = Object.values(pages[0]!.nodes)
    const hero = nodes.find((n) => n.classIds.includes(overrideHeroId))
    expect(hero).toBeDefined()
    expect(nodes.some((n) => n.classIds.includes(homeHeroId))).toBe(false)
  })

  it('returns an empty sources map alongside an empty styleRules map', async () => {
    write('pages/Home.tsx', ['export default function Home() {', '  return <div className="hero" />', '}', ''].join('\n'))

    const { styleRules, styleRuleSources } = await loadStudioPages(tmpDir)

    expect(styleRules).toEqual({})
    expect(styleRuleSources).toEqual({})
  })
})

describe('classIdsForClassName', () => {
  const map = { hero: 'sc-aaa', badge: 'sc-bbb' }

  it('maps each whitespace-separated name that has a rule', () => {
    expect(classIdsForClassName('hero badge', map)).toEqual(['sc-aaa', 'sc-bbb'])
  })

  it('drops names with no rule instead of inventing a dangling id', () => {
    expect(classIdsForClassName('hero unknown-class', map)).toEqual(['sc-aaa'])
  })

  it('tolerates irregular whitespace and deduplicates', () => {
    expect(classIdsForClassName('  hero   hero  ', map)).toEqual(['sc-aaa'])
  })
})

describe('styleRuleId', () => {
  it('is deterministic and distinguishes kind', () => {
    expect(styleRuleId('class', 'hero', 'a.css')).toBe(styleRuleId('class', 'hero', 'a.css'))
    expect(styleRuleId('class', 'hero', 'a.css')).not.toBe(styleRuleId('ambient', 'hero', 'a.css'))
    expect(styleRuleId('class', 'hero', 'a.css')).toMatch(/^sc-[0-9a-f]{10}$/)
  })

  // Track B1's landmine fix (S3d) — the file is now part of the id, so the
  // SAME (kind, name) in two different files no longer collapses onto one.
  it('distinguishes the same (kind, name) in two different files', () => {
    expect(styleRuleId('class', 'hero', 'a.css')).not.toBe(styleRuleId('class', 'hero', 'b.css'))
  })
})
