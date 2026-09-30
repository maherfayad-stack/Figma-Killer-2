/**
 * A multi-selection's per-row "writes to 3 of 5" count reaches the app
 * (`docs/features/inspector.md` §9.4a).
 *
 * The bug this pins: `StyleWriteLockContext` grew a `partial` state carrying
 * a per-property count, and `ClassPropertyRow` knew how to state it — but no
 * component rendered the provider, so every row read `null` and the count
 * never showed. Select two `.map` rows whose rotation comes from the row data
 * plus one static card, and the Rotation row claimed a clean write to all
 * three layers while `setNodesInlineStyles` skipped two of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { StyleSurface } from '../StyleSurface'
import type { StyleRule } from '@core/page-tree'
import { MultiSelectTargetProvider } from '@site/inspector/MultiSelectTargetProvider'
import { MultiSelectTargetContext } from '@site/inspector/multiSelectTarget'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

/** Two iterations of one `.map` row template, and a card outside the list. */
const ROW_0 = 'pages/List.tsx:14:9#0'
const ROW_1 = 'pages/List.tsx:14:9#1'
const CARD = 'pages/List.tsx:22:5'

function selectRowsAndCard(ids: readonly string[], sharedClass?: StyleRule) {
  const rootId = 'page-1:body'
  // Each row is `style={{ transform: `rotate(${item.deg}deg)` }}` — the
  // parser lists the property in `codeProps`, because the panel cannot write
  // it without destroying the binding to `item.deg`. The card writes the same
  // value as a literal, so the collapsed bag agrees and Measures draws its
  // raw `transform` row (a rotation already inside `transform`).
  const classIds = sharedClass ? [sharedClass.id] : []
  const row = (id: string) => ({
    ...makeNode({ id, moduleId: 'base.div', classIds }),
    inlineStyles: { transform: 'rotate(4deg)' },
    codeProps: ['style:transform'],
  })
  const nodes = {
    [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [ROW_0, ROW_1, CARD] }),
    [ROW_0]: row(ROW_0),
    [ROW_1]: row(ROW_1),
    [CARD]: { ...makeNode({ id: CARD, moduleId: 'base.div', classIds }), inlineStyles: { transform: 'rotate(4deg)' } },
  }
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes })
  useEditorStore.setState({
    site: makeSite({ pages: [page], styleRules: sharedClass ? { [sharedClass.id]: sharedClass } : {} }),
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: ids[ids.length - 1],
    selectedNodeIds: [...ids],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    _nodeIdToPageIds: new Map(Object.keys(nodes).map((id) => [id, [page.id]])),
  } as Parameters<typeof useEditorStore.setState>[0])
}

function renderSurface() {
  return render(
    <MultiSelectTargetProvider>
      <StyleSurface moduleContent={null} />
    </MultiSelectTargetProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
})

afterEach(cleanup)

describe('StyleSurface — a partial write states its count on the row', () => {
  it('marks the Rotation row of two .map rows and a card with "writes to 1 of 3"', () => {
    selectRowsAndCard([ROW_0, ROW_1, CARD])
    renderSurface()

    const row = screen.getByTestId('css-property-row-transform')
    expect(row.getAttribute('data-write-partial')).toBe('true')
    expect(row.getAttribute('title')).toBe(
      'Writes to 1 of 3 selected layers — 2 are set from an expression in code.',
    )
    // `partial` never disables: the card still takes the edit.
    expect(row.getAttribute('data-write-locked')).toBeNull()
  })

  it('says nothing on a property every selected layer takes', () => {
    selectRowsAndCard([ROW_0, ROW_1, CARD])
    renderSurface()

    // The count is per PROPERTY: nothing else in the column discloses one.
    const disclosing = [...document.querySelectorAll('[data-write-partial="true"]')].map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(disclosing).toEqual(['css-property-row-transform'])
  })

  it('states no count for a single .map row, which uses its own code locks', () => {
    selectRowsAndCard([ROW_0])
    renderSurface()

    expect(screen.getByTestId('css-property-row-transform').getAttribute('data-write-partial')).toBeNull()
  })

  it('states no count once the shared class is the target — one write reaches every carrier', () => {
    const card: StyleRule = {
      id: 'sc-card',
      name: 'card',
      kind: 'class',
      selector: '.card',
      order: 0,
      styles: { transform: 'rotate(4deg)' },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    } as StyleRule
    setStudioStyleRuleSources({ [card.id]: { file: 'pages/List.css', selector: '.card' } }, {})
    selectRowsAndCard([ROW_0, ROW_1, CARD], card)
    render(
      <MultiSelectTargetContext.Provider value={{ classId: card.id, setClassId: () => {} }}>
        <StyleSurface moduleContent={null} />
      </MultiSelectTargetContext.Provider>,
    )

    expect(screen.getByTestId('css-property-row-transform').getAttribute('data-write-partial')).toBeNull()
  })
})
