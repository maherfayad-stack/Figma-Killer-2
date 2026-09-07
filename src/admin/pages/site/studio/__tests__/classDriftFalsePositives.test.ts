/**
 * `class-toast` — the save-time class diff must only ever report a class
 * change the USER made.
 *
 * The bug this suite locks down: editing a Border on one element fired
 * "Class change won't be saved — Container (added statusBar); Text (added
 * time); Container (added islandSpacer); and 5 more" — the eight children of
 * an inlined local component whose classes the user never touched. Two
 * independent defects produced it, and both are exercised below against the
 * real modules the save path calls:
 *
 *   1. `collectClassIdsDrift` read a MISSING baseline entry as `[]`, so any
 *      node that entered the document after the load-time snapshot (a
 *      `cloneSubtree` duplicate/paste, an optimistically inserted subtree, a
 *      re-addressed id) reported every class it arrived with as "added".
 *   2. `collectClassNameEdits` asked only `hasWritableSourceLocation`, which
 *      is `false` both for a `.map` row (ours, genuinely refused) and for an
 *      id the studio importer never minted (a `nanoid()` clone) — so the
 *      second kind landed in the honesty toast that exists for the first.
 *
 * The honest refusals stay: a `.map` row and an imported page's synthetic
 * `<pageId>:body` root still report, and an ordinary class assignment still
 * becomes a `kind: 'class'` edit.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { Page, StyleRule } from '@core/page-tree'
import { collectClassNameEdits } from '../classNameWriteback'
import { collectClassIdsDrift, getLoadedClassIds, resetLoadedValues } from '../loadedValuesBaseline'
import { setStudioStyleRuleSources } from '../styleRuleWriteback'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

/** One plain-CSS class, so `resolveClassToken` yields a literal token and nothing refuses on spelling. */
const CARD: StyleRule = {
  id: 'sc-card',
  name: 'card',
  kind: 'class',
  selector: '.card',
  styles: {},
  contextStyles: {},
  createdAt: 0,
  updatedAt: 0,
} as unknown as StyleRule

const STATUS_BAR: StyleRule = { ...CARD, id: 'sc-statusbar', name: 'statusBar', displayName: 'statusBar', selector: '.statusBar' } as unknown as StyleRule

const styleRules: Record<string, StyleRule> = { [CARD.id]: CARD, [STATUS_BAR.id]: STATUS_BAR }

/** A page holding exactly the given nodes under a studio-imported synthetic root. */
function pageWith(nodes: Array<{ id: string; classIds: string[] }>): Page {
  return makePage({
    id: 'onboarding',
    rootNodeId: 'onboarding:body',
    nodes: {
      'onboarding:body': makeNode({
        id: 'onboarding:body',
        moduleId: 'base.body',
        children: nodes.map((n) => n.id),
      }),
      ...Object.fromEntries(
        nodes.map((n) => [n.id, makeNode({ id: n.id, moduleId: 'base.container', classIds: n.classIds })]),
      ),
    },
  })
}

function plan(pages: Page[]) {
  return collectClassNameEdits(pages, styleRules, [])
}

beforeEach(() => {
  // A plain `.css` source for both rules — the token resolves to a literal, so
  // nothing in these cases refuses for a reason other than the one under test.
  setStudioStyleRuleSources(
    { [CARD.id]: { file: 'pages/Onboarding.css', selector: '.card' }, [STATUS_BAR.id]: { file: 'components/IOSStatusBar.css', selector: '.statusBar' } },
    styleRules,
  )
})

describe('a node the baseline never observed is not a user class change', () => {
  it('an inlined component subtree that appeared after the load-time snapshot reports nothing', () => {
    // As loaded: the call site only. The eight inlined children are not in the
    // baseline — the shape a re-addressed / freshly materialised subtree has.
    resetLoadedValues([pageWith([{ id: 'pages/Onboarding.tsx:15:8', classIds: [] }])])

    const withSubtree = pageWith([
      { id: 'pages/Onboarding.tsx:15:8', classIds: [] },
      { id: 'pages/Onboarding.tsx:15:8~components/IOSStatusBar.tsx:8:6', classIds: [STATUS_BAR.id] },
      { id: 'pages/Onboarding.tsx:15:8~components/IOSStatusBar.tsx:9:8', classIds: [STATUS_BAR.id] },
    ])

    expect(collectClassIdsDrift([withSubtree])).toEqual([])
    const result = plan([withSubtree])
    expect(result.unwritable).toEqual([])
    expect(result.edits).toEqual([])
  })

  it('a duplicate/paste clone (fresh nanoid id, copied classIds) reports nothing', () => {
    resetLoadedValues([pageWith([{ id: 'pages/Onboarding.tsx:3:1', classIds: [CARD.id] }])])

    const afterDuplicate = pageWith([
      { id: 'pages/Onboarding.tsx:3:1', classIds: [CARD.id] },
      // `cloneSubtree` mints a nanoid and COPIES classIds.
      { id: 'V1StGXR8_Z5jdHi6B-myT', classIds: [CARD.id] },
    ])

    const result = plan([afterDuplicate])
    expect(result.unwritable).toEqual([])
    expect(result.edits).toEqual([])
  })

  it('still tells an unclassed node apart from an unobserved one', () => {
    resetLoadedValues([pageWith([{ id: 'pages/Onboarding.tsx:3:1', classIds: [] }])])
    // Observed with NO classes — an empty array, not an absent entry.
    expect(getLoadedClassIds('pages/Onboarding.tsx:3:1')).toEqual([])
    expect(getLoadedClassIds('pages/Onboarding.tsx:99:1')).toBeUndefined()
  })
})

describe('the honest cases are unchanged', () => {
  it('a class assigned to an observed, writable node still becomes one `kind: class` edit', () => {
    resetLoadedValues([pageWith([{ id: 'pages/Onboarding.tsx:3:1', classIds: [] }])])

    const result = plan([pageWith([{ id: 'pages/Onboarding.tsx:3:1', classIds: [CARD.id] }])])

    expect(result.unwritable).toEqual([])
    expect(result.edits).toEqual([
      { kind: 'class', nodeId: 'pages/Onboarding.tsx:3:1', add: [{ kind: 'literal', token: 'card' }], remove: [] },
    ])
  })

  it('a class assigned to an INLINED node the baseline did observe still writes to the component file', () => {
    const inlinedId = 'pages/Onboarding.tsx:15:8~components/IOSStatusBar.tsx:8:6'
    resetLoadedValues([pageWith([{ id: inlinedId, classIds: [] }])])

    const result = plan([pageWith([{ id: inlinedId, classIds: [CARD.id] }])])

    expect(result.unwritable).toEqual([])
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0]!.nodeId).toBe(inlinedId)
  })

  it('a `.map` row keeps the honest refusal', () => {
    resetLoadedValues([pageWith([{ id: 'pages/Onboarding.tsx:70:21#2', classIds: [] }])])

    const result = plan([pageWith([{ id: 'pages/Onboarding.tsx:70:21#2', classIds: [CARD.id] }])])

    expect(result.edits).toEqual([])
    expect(result.unwritable).toHaveLength(1)
    expect(result.unwritable[0]!.addedClassNames).toEqual(['card'])
  })

  it("an imported page's synthetic `<pageId>:body` root keeps the honest refusal", () => {
    resetLoadedValues([pageWith([])])

    const withClassOnRoot = pageWith([])
    withClassOnRoot.nodes['onboarding:body']!.classIds = [CARD.id]

    const result = plan([withClassOnRoot])

    expect(result.edits).toEqual([])
    expect(result.unwritable).toHaveLength(1)
  })
})
