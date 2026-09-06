/**
 * `classCssWritability` — the pre-flight predicate the inspector uses to
 * decide, BEFORE a keystroke, whether declarations typed into a class can
 * reach the user's source.
 *
 * Two things are being pinned here:
 *
 *   1. The five write-back tiers, resolved from the same `styleRuleSources`
 *      map + `resolveCssInsertDestination` the save path itself uses.
 *   2. That the lock derived from them is gated on a Studio session — outside
 *      Studio every class is `unmapped` (there is no file to map to) and
 *      locking on that would disable the entire panel in the DB-backed editor.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import {
  classCssWriteLockReason,
  resolveClassCssEditability,
  UNMAPPED_CLASS_LOCK_REASON,
} from '@site/panels/PropertiesPanel/classCssWritability'

function makeRule(overrides: Partial<StyleRule> & Pick<StyleRule, 'id'>): StyleRule {
  return {
    name: 'card',
    kind: 'class',
    selector: '.card',
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

beforeEach(() => {
  // Clears the module-level `styleRuleSources` map between cases.
  setStudioStyleRuleSources({}, {})
})

describe('resolveClassCssEditability', () => {
  it('reports a hand-authored .css source as plain-css', () => {
    const rule = makeRule({ id: 'sc-abc1234567' })
    setStudioStyleRuleSources({ [rule.id]: { file: 'src/pages/Home.css', selector: '.card' } }, {})
    expect(resolveClassCssEditability(rule)).toEqual({ kind: 'plain-css', file: 'src/pages/Home.css' })
  })

  it('reports a build-output source as compiled, carrying the classifier’s reason', () => {
    const rule = makeRule({ id: 'sc-abc1234567' })
    setStudioStyleRuleSources({ [rule.id]: { file: 'dist/style.css', selector: '.card' } }, {})
    const editability = resolveClassCssEditability(rule)
    expect(editability.kind).toBe('compiled')
    expect(editability.kind === 'compiled' && editability.reason.length > 0).toBe(true)
  })

  it('never offers an insert destination to an IMPORTED rule with no source', () => {
    // The `sc-` prefix is `isImportedStyleRuleId`'s marker — the invariant
    // `StyleSurface` used to restate as `!id.startsWith('sc-')`.
    expect(resolveClassCssEditability(makeRule({ id: 'sc-abc1234567' }))).toEqual({ kind: 'unmapped' })
  })

  it('offers the co-located stylesheet of a node-scoped editor-authored rule', () => {
    setStudioStyleRuleSources(
      {
        'sc-existing0001': { file: 'src/pages/Home.module.css', selector: '.hero' },
        'sc-existing0002': { file: 'src/pages/About.module.css', selector: '.hero' },
      },
      {},
    )
    const rule = makeRule({
      id: 'V1StGXR8IZ5jdHi6B',
      scope: { type: 'node', nodeId: 'src/pages/Home.tsx:12:4', role: 'module-style' },
    })
    // Two candidate stylesheets exist — without the scope this is the
    // `ambiguous-stylesheet` refusal ClassPicker's missing scope produced.
    expect(resolveClassCssEditability(rule)).toEqual({
      kind: 'will-create-existing',
      file: 'src/pages/Home.module.css',
    })
  })

  it('refuses an editor-authored rule with no scope and several candidates', () => {
    setStudioStyleRuleSources(
      {
        'sc-existing0001': { file: 'src/pages/Home.module.css', selector: '.hero' },
        'sc-existing0002': { file: 'src/pages/About.module.css', selector: '.hero' },
      },
      {},
    )
    const editability = resolveClassCssEditability(makeRule({ id: 'V1StGXR8IZ5jdHi6B' }))
    expect(editability.kind).toBe('unmapped')
    expect(editability.kind === 'unmapped' && editability.reason).toContain('2 candidate stylesheets')
  })
})

describe('classCssWriteLockReason', () => {
  it('does not lock the three tiers that actually write', () => {
    const studio = { studioSession: true }
    expect(classCssWriteLockReason({ kind: 'plain-css', file: 'a.css' }, studio)).toBeNull()
    expect(classCssWriteLockReason({ kind: 'will-create-existing', file: 'a.css' }, studio)).toBeNull()
    expect(classCssWriteLockReason({ kind: 'will-create-new-stylesheet', pageFile: 'a.tsx' }, studio)).toBeNull()
  })

  it('locks a compiled class regardless of session (it is only reachable in Studio)', () => {
    expect(classCssWriteLockReason({ kind: 'compiled', reason: 'Minified.' }, { studioSession: false }))
      .toBe('Minified.')
  })

  it('locks an unmapped class only inside a Studio session', () => {
    expect(classCssWriteLockReason({ kind: 'unmapped' }, { studioSession: true }))
      .toBe(UNMAPPED_CLASS_LOCK_REASON)
    expect(classCssWriteLockReason({ kind: 'unmapped' }, { studioSession: false })).toBeNull()
  })

  it('prefers the destination refusal’s own wording when there is one', () => {
    expect(classCssWriteLockReason({ kind: 'unmapped', reason: 'Two candidates.' }, { studioSession: true }))
      .toBe('Two candidates.')
  })

  it('is not a lock when no class is open for editing at all', () => {
    expect(classCssWriteLockReason(undefined, { studioSession: true })).toBeNull()
  })
})
