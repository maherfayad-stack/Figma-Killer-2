/**
 * `panel-02` — the client half of the CSS write-back diff.
 *
 * The test that matters most here is the FIRST one. Every inspector edit on a
 * studio board lands in `contextStyles.studio` (the synthetic per-frame
 * breakpoint `BoardFramesLayer.tsx` mounts), never in the rule's `styles` bag.
 * A diff that reads `styles` alone compares two identical objects on every
 * save and emits nothing — which is exactly how this feature shipped once
 * already: byte-exact codemod tests green, and not one declaration ever
 * reaching a file. The gate at the bottom pins the id the two modules must
 * agree on, so that failure cannot come back silently.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { StyleRule } from '@core/page-tree'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  commitBaseline,
  getStudioStyleRuleSources,
  recordCreatedStylesheet,
  resolveCssInsertDestination,
  ruleIdFromCssCreateNodeId,
  setStudioStyleRuleSources,
} from '@site/studio/styleRuleWriteback'

const RULE_ID = 'sc-hero'

function rule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: RULE_ID,
    kind: 'class',
    name: 'hero-title',
    selector: '.hero-title',
    styles: { width: '120px', fontSize: '24px' },
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

const SOURCES = { [RULE_ID]: { file: 'pages/Home.css', selector: '.hero-title' } }

beforeEach(() => {
  setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() })
})

describe('collectStyleRuleEdits — the studio context is the base declaration set', () => {
  it('emits an edit for a value the inspector wrote into contextStyles.studio', () => {
    const edited = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } } })

    const plan = collectStyleRuleEdits({ [RULE_ID]: edited })

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      file: 'pages/Home.css',
      selector: '.hero-title',
      property: 'width',
      value: '321px',
    })
  })

  it('emits nothing when nothing changed', () => {
    expect(collectStyleRuleEdits({ [RULE_ID]: rule() }).edits).toHaveLength(0)
  })

  it('still handles a plain `styles` change (a rule edited outside the board)', () => {
    const edited = rule({ styles: { width: '200px', fontSize: '24px' } })
    expect(collectStyleRuleEdits({ [RULE_ID]: edited }).edits[0]).toMatchObject({ property: 'width', value: '200px' })
  })

  it('lets the studio context win over the base bag for the same property', () => {
    const edited = rule({
      styles: { width: '200px', fontSize: '24px' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } },
    })
    const widths = collectStyleRuleEdits({ [RULE_ID]: edited }).edits.filter((e) => e.property === 'width')
    expect(widths).toHaveLength(1)
    expect(widths[0]!.value).toBe('321px')
  })

  it('converts camelCase property names to kebab-case for the stylesheet', () => {
    const edited = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { fontSize: '30px' } } })
    expect(collectStyleRuleEdits({ [RULE_ID]: edited }).edits[0]!.property).toBe('font-size')
  })
})

describe('collectStyleRuleEdits — what it refuses instead of dropping', () => {
  it('reports a changed rule with no mapped .css source rather than skipping it silently', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: rule() })
    const edited = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } } })

    const plan = collectStyleRuleEdits({ [RULE_ID]: edited })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped).toEqual(['.hero-title'])
  })

  it('reports a REAL breakpoint override, which needs a media query this edit kind cannot carry', () => {
    const edited = rule({ contextStyles: { mobile: { width: '90px' } } })

    const plan = collectStyleRuleEdits({ [RULE_ID]: edited })

    expect(plan.unwritableContexts).toEqual(['.hero-title'])
    expect(plan.edits).toHaveLength(0)
  })

  it('does not report an imported breakpoint override nobody touched', () => {
    const withOverride = rule({ contextStyles: { mobile: { width: '90px' } } })
    setStudioStyleRuleSources(SOURCES, { [RULE_ID]: withOverride })

    expect(collectStyleRuleEdits({ [RULE_ID]: withOverride }).unwritableContexts).toHaveLength(0)
  })
})

describe('collectStyleRuleEdits — baseline discipline', () => {
  it('stops re-emitting an edit once the baseline is committed', () => {
    const edited = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } } })
    expect(collectStyleRuleEdits({ [RULE_ID]: edited }).edits).toHaveLength(1)

    commitBaseline({ [RULE_ID]: edited })

    // Without this, every 2-second autosave tick would re-send the same
    // declaration and re-toast any refusal it produced.
    expect(collectStyleRuleEdits({ [RULE_ID]: edited }).edits).toHaveLength(0)
  })

  it('emits again when the user changes the value a second time', () => {
    const first = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } } })
    collectStyleRuleEdits({ [RULE_ID]: first })
    commitBaseline({ [RULE_ID]: first })

    const second = rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '400px' } } })
    expect(collectStyleRuleEdits({ [RULE_ID]: second }).edits[0]!.value).toBe('400px')
  })
})

describe('the write-back source map', () => {
  it('is what StyleTargetChip reads to decide a class’s tier', () => {
    expect(getStudioStyleRuleSources()[RULE_ID]).toEqual({ file: 'pages/Home.css', selector: '.hero-title' })
  })
})

/**
 * Track B1 — a rule the user created IN THE EDITOR (a `nanoid()` id, never
 * `sc-`) has no `styleRuleSources` entry at all, but — unlike an IMPORTED
 * unmapped rule (Tailwind/Sass/PostCSS output) — it has never had a chance
 * to reach disk. `resolveCssInsertDestination` decides where its first write
 * goes; `collectStyleRuleEdits` emits a full `insert` edit for it instead of
 * reporting it unmapped forever; `commitBaseline` synthesizes the source so
 * the SAME rule is editable through the ordinary `set` path on its very next
 * edit, with no reload.
 */
describe('collectStyleRuleEdits — Track B1 insert for an editor-authored rule with no source', () => {
  const NEW_RULE_ID = 'nanoid-new-class'

  function newRule(overrides: Partial<StyleRule> = {}): StyleRule {
    return {
      id: NEW_RULE_ID,
      kind: 'class',
      name: 'new-class',
      selector: '.new-class',
      styles: {},
      contextStyles: {},
      order: 1,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as StyleRule
  }

  it('emits an insert edit when exactly one editable stylesheet is known', () => {
    // Only ONE distinct, plain-css file appears across styleRuleSources — the
    // single-candidate case `resolveCssInsertDestination` resolves.
    setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() })
    const edited = newRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red', display: 'flex' } } })

    const plan = collectStyleRuleEdits({ [RULE_ID]: rule(), [NEW_RULE_ID]: edited })

    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'insert',
      file: 'pages/Home.css',
      selector: '.new-class',
      declarations: { color: 'red', display: 'flex' },
    })
  })

  it('refuses with no-editable-stylesheet when there is no candidate and no page to co-locate a new one with', () => {
    setStudioStyleRuleSources({}, {})
    // No `scope` at all — a freestanding class, e.g. made via ClassPicker's
    // "create class" with nothing selected. No page association, so this
    // refuses rather than guessing "the currently open page".
    const edited = newRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } } })

    const plan = collectStyleRuleEdits({ [NEW_RULE_ID]: edited })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped).toHaveLength(1)
    expect(plan.unmapped[0]).toContain('.new-class')
    expect(plan.unmapped[0]).toContain('could not find a hand-editable .css file')
  })

  it('emits a create edit, naming the page, when zero stylesheets exist but the rule is node-scoped to a real page', () => {
    setStudioStyleRuleSources({}, {})
    const edited = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red', display: 'flex' } },
    })

    const plan = collectStyleRuleEdits({ [NEW_RULE_ID]: edited })

    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'create',
      pageFile: 'src/pages/Home.tsx',
      selector: '.new-class',
      declarations: { color: 'red', display: 'flex' },
    })
    expect(plan.edits[0]!.nodeId).toBe(`css:create:${NEW_RULE_ID}`)
  })

  it('refuses with ambiguous-stylesheet, naming the candidates, when more than one stylesheet is known — never creates', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'pages/Home.css', selector: '.a' },
        b: { file: 'pages/Other.css', selector: '.b' },
      },
      {},
    )
    // Even a node-scoped rule (a real page to co-locate with) must NOT create
    // a third file when the ambiguity is about which EXISTING file to use.
    const edited = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } },
    })

    const plan = collectStyleRuleEdits({ [NEW_RULE_ID]: edited })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped[0]).toContain('.new-class')
    expect(plan.unmapped[0]).toContain('pages/Home.css')
    expect(plan.unmapped[0]).toContain('pages/Other.css')
  })

  it('does NOT insert-candidate an IMPORTED rule even with no source (sc- prefix stays unmapped)', () => {
    setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() })
    // sc-orphan has no styleRuleSources entry (e.g. a Tailwind/Sass-origin
    // rule) but carries the deterministic `sc-` prefix — never a candidate.
    const orphan = { ...rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } } }), id: 'sc-orphan', name: 'orphan', selector: '.orphan' }

    const plan = collectStyleRuleEdits({ [RULE_ID]: rule(), 'sc-orphan': orphan })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped).toEqual(['.orphan'])
  })

  it('synthesizes a styleRuleSources entry after commitBaseline, so the next edit takes the ordinary set path', () => {
    setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() })
    const edited = newRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } } })

    const firstPlan = collectStyleRuleEdits({ [RULE_ID]: rule(), [NEW_RULE_ID]: edited })
    expect(firstPlan.edits[0]).toMatchObject({ op: 'insert' })

    // The save round trip "succeeds" — commitBaseline runs, exactly as
    // fsCodemodAdapter.ts does after a successful POST.
    commitBaseline({ [RULE_ID]: rule(), [NEW_RULE_ID]: edited })

    expect(getStudioStyleRuleSources()[NEW_RULE_ID]).toEqual({ file: 'pages/Home.css', selector: '.new-class' })

    // A second edit to the SAME rule now resolves through `set`, not another `insert`.
    const editedAgain = newRule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } } })
    const secondPlan = collectStyleRuleEdits({ [RULE_ID]: rule(), [NEW_RULE_ID]: editedAgain })

    expect(secondPlan.edits).toHaveLength(1)
    expect(secondPlan.edits[0]).toMatchObject({
      op: 'set',
      file: 'pages/Home.css',
      selector: '.new-class',
      property: 'color',
      value: 'blue',
    })
  })

  it('does NOT synthesize a source for a create destination — commitBaseline cannot know the server-chosen file', () => {
    setStudioStyleRuleSources({}, {})
    const edited = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } },
    })

    const firstPlan = collectStyleRuleEdits({ [NEW_RULE_ID]: edited })
    expect(firstPlan.edits[0]).toMatchObject({ op: 'create', pageFile: 'src/pages/Home.tsx' })

    commitBaseline({ [NEW_RULE_ID]: edited })

    expect(getStudioStyleRuleSources()[NEW_RULE_ID]).toBeUndefined()

    // Without the server's echoed result, the NEXT edit still refuses (not a
    // fabricated `set` against a guessed path) — same shape as a genuinely
    // unmapped rule, until `recordCreatedStylesheet` is told the real file.
    const editedAgain = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } },
    })
    const secondPlan = collectStyleRuleEdits({ [NEW_RULE_ID]: editedAgain })
    expect(secondPlan.edits[0]).toMatchObject({ op: 'create' })
  })

  it('recordCreatedStylesheet makes a create-branch rule writable through the ordinary set path', () => {
    setStudioStyleRuleSources({}, {})
    const edited = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'red' } },
    })

    const firstPlan = collectStyleRuleEdits({ [NEW_RULE_ID]: edited })
    const createdNodeId = firstPlan.edits[0]!.nodeId
    commitBaseline({ [NEW_RULE_ID]: edited })

    // The server's response echoes the edit's own nodeId back — this is the
    // decode step `notifyCreatedStylesheets` performs in production.
    const ruleId = ruleIdFromCssCreateNodeId(createdNodeId)
    expect(ruleId).toBe(NEW_RULE_ID)
    recordCreatedStylesheet(ruleId!, 'src/pages/Home.module.css', '.new-class')

    expect(getStudioStyleRuleSources()[NEW_RULE_ID]).toEqual({
      file: 'src/pages/Home.module.css',
      selector: '.new-class',
    })

    const editedAgain = newRule({
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' },
      contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'blue' } },
    })
    const secondPlan = collectStyleRuleEdits({ [NEW_RULE_ID]: editedAgain })
    expect(secondPlan.edits).toHaveLength(1)
    expect(secondPlan.edits[0]).toMatchObject({
      op: 'set',
      file: 'src/pages/Home.module.css',
      selector: '.new-class',
      property: 'color',
      value: 'blue',
    })
  })
})

describe('ruleIdFromCssCreateNodeId', () => {
  it('decodes a create edit synthetic nodeId back to its rule id', () => {
    expect(ruleIdFromCssCreateNodeId('css:create:nanoid-new-class')).toBe('nanoid-new-class')
  })

  it('returns null for anything else', () => {
    expect(ruleIdFromCssCreateNodeId('css:insert:pages/Home.css#.new-class')).toBeNull()
    expect(ruleIdFromCssCreateNodeId('src/pages/Home.tsx:12:5')).toBeNull()
  })
})

describe('resolveCssInsertDestination', () => {
  // No `scope` — irrelevant to the `existing`/`ambiguous` branches, which
  // never consult the rule's page at all.
  const unscopedRule = rule()
  const nodeScopedRule = rule({ scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:5', role: 'module-style' } })

  it('resolves the single known plain-css file', () => {
    setStudioStyleRuleSources({ a: { file: 'pages/Home.css', selector: '.a' } }, {})
    expect(resolveCssInsertDestination(unscopedRule)).toEqual({ ok: true, kind: 'existing', file: 'pages/Home.css' })
  })

  it('ignores a compiled/non-editable stylesheet as a candidate', () => {
    setStudioStyleRuleSources(
      { a: { file: 'pages/Home.css', selector: '.a' }, b: { file: 'dist/style.min.css', selector: '.b' } },
      {},
    )
    expect(resolveCssInsertDestination(unscopedRule)).toEqual({ ok: true, kind: 'existing', file: 'pages/Home.css' })
  })

  it('refuses when zero candidates exist and the rule has no page association', () => {
    setStudioStyleRuleSources({}, {})
    const result = resolveCssInsertDestination(unscopedRule)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'no-editable-stylesheet' })
  })

  it('offers to create a co-located stylesheet when zero candidates exist but the rule names a real page', () => {
    setStudioStyleRuleSources({}, {})
    expect(resolveCssInsertDestination(nodeScopedRule)).toEqual({
      ok: true,
      kind: 'create',
      pageFile: 'src/pages/Home.tsx',
    })
  })

  it('does not offer to create for a rule scoped to a non-source (CMS) node id', () => {
    setStudioStyleRuleSources({}, {})
    const cmsScoped = rule({ scope: { type: 'node', nodeId: 'abc123nanoid', role: 'module-style' } })
    const result = resolveCssInsertDestination(cmsScoped)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'no-editable-stylesheet' })
  })

  it('refuses with ambiguous-stylesheet when more than one candidate exists', () => {
    setStudioStyleRuleSources(
      { a: { file: 'pages/Home.css', selector: '.a' }, b: { file: 'pages/Other.css', selector: '.b' } },
      {},
    )
    const result = resolveCssInsertDestination(unscopedRule)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })

  it('refuses with ambiguous-stylesheet even for a node-scoped rule — never creates a third file', () => {
    setStudioStyleRuleSources(
      { a: { file: 'pages/Home.css', selector: '.a' }, b: { file: 'pages/Other.css', selector: '.b' } },
      {},
    )
    const result = resolveCssInsertDestination(nodeScopedRule)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })
})

/**
 * `STUDIO_BREAKPOINT_ID` is declared in `styleRuleWriteback.ts` because its
 * producer keeps it private. If the board ever renames the synthetic
 * breakpoint, the diff above silently stops matching and CSS write-back goes
 * back to writing nothing — the exact regression this whole file exists for.
 */
describe('the synthetic studio breakpoint id stays in sync with the board', () => {
  it('matches the id the board frame layer mounts on every frame', () => {
    // Scan the whole directory rather than one filename: the 700-line
    // module-size gate keeps forcing this layer to split (the declaration has
    // already moved from BoardFramesLayer.tsx to BoardFrameView.tsx once), and
    // a test pinned to a filename goes vacuously green the next time it moves.
    const dir = join(import.meta.dir, '../../admin/pages/site/canvas/BoardFramesLayer')
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
    expect(
      sources.some((s) => s.includes(`id: '${STUDIO_BREAKPOINT_ID}'`)),
      `No file in BoardFramesLayer/ declares id: '${STUDIO_BREAKPOINT_ID}' — CSS write-back reads that context and will now write nothing`,
    ).toBe(true)
  })
})

/**
 * Framework-generated utilities must never reach the diff.
 *
 * These are derived from `.studio/framework.json`'s token settings and
 * regenerated from them, so they have no hand-authored `.css` file and no
 * `styleRuleSources` entry. Importing a design system adds colour tokens, the
 * framework generates a class per token, and those classes land in
 * `site.styleRules` after the last `commitBaseline` — so every property reads
 * as changed against an empty baseline and a screen's worth of untouched
 * generated classes was reported as "Style not saved to source".
 */
describe('framework-generated utility classes', () => {
  function generatedRule(id: string, name: string): StyleRule {
    return {
      id,
      kind: 'class',
      name,
      selector: `.${name}`,
      styles: { color: 'var(--color-metal)' },
      contextStyles: {},
      order: 0,
      createdAt: 0,
      updatedAt: 0,
      generated: {
        origin: 'framework',
        family: 'color',
        sourceId: 'metal',
        utility: 'text',
        tokenName: 'metal',
        locked: true,
      },
    } as unknown as StyleRule
  }

  beforeEach(() => {
    setStudioStyleRuleSources({}, {})
  })

  it('does not report a generated class as unmapped, even with no baseline', () => {
    const rules = {
      'sc-a': generatedRule('sc-a', 'text-color-metal'),
      'sc-b': generatedRule('sc-b', 'bg-color-metal-5'),
    }

    const plan = collectStyleRuleEdits(rules)

    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toEqual([])
  })

  it('never emits an edit for a generated class even when a source is mapped', () => {
    // Belt and braces: skipping happens before the diff, so a stray source
    // entry cannot make one writable either.
    setStudioStyleRuleSources({ 'sc-a': { file: 'styles/app.css', selector: '.text-color-metal' } }, {})

    expect(collectStyleRuleEdits({ 'sc-a': generatedRule('sc-a', 'text-color-metal') }).edits).toEqual([])
  })

  it('still reports a genuinely unmapped HAND-AUTHORED class', () => {
    // The refusal path must survive — this is the case the toast exists for.
    const plan = collectStyleRuleEdits({ [RULE_ID]: rule() })

    expect(plan.unmapped).toEqual(['.hero-title'])
  })
})
