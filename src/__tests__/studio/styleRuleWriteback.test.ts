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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StyleRule } from '@core/page-tree'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  commitBaseline,
  getStudioStyleRuleSources,
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
 * `STUDIO_BREAKPOINT_ID` is declared in `styleRuleWriteback.ts` because its
 * producer keeps it private. If the board ever renames the synthetic
 * breakpoint, the diff above silently stops matching and CSS write-back goes
 * back to writing nothing — the exact regression this whole file exists for.
 */
describe('the synthetic studio breakpoint id stays in sync with the board', () => {
  it('matches the id BoardFramesLayer mounts on every frame', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx'),
      'utf8',
    )
    expect(
      source.includes(`id: '${STUDIO_BREAKPOINT_ID}'`),
      `BoardFramesLayer.tsx no longer declares id: '${STUDIO_BREAKPOINT_ID}' — CSS write-back reads that context and will now write nothing`,
    ).toBe(true)
  })
})
