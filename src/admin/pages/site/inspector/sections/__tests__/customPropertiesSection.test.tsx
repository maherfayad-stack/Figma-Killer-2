/**
 * CustomPropertiesSection (manifest wrapper) — Studio's own "Custom
 * properties" section (`STATE.md` `panel-25`, P3 item 11 — Studio extras,
 * last of the six new entries).
 *
 * Component-level coverage for the thin wrapper — the pure-fn
 * curated/uncurated split (`isCuratedProperty`/`getCustomProperties`) is
 * covered by `src/__tests__/panels/customProperties.test.ts` and untouched.
 *
 * Covers:
 *   1. Renders a row for a set, uncurated property; a curated property never
 *      shows up here (`ALL_CURATED_CSS_PROPERTIES` excludes it from
 *      `getCustomProperties`'s output).
 *   2. Editing the row's value commits through `commitStyle`.
 *   3. The locked-properties notice fires ONLY for a locked UNCURATED
 *      property — a locked CURATED property is not this section's to report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { CustomPropertiesSection } from '../CustomPropertiesSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectNode(overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', ...overrides }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function currentNode() {
  return useEditorStore.getState().site?.pages[0]?.nodes[NODE_ID]
}

describe('CustomPropertiesSection (manifest wrapper) — curated/uncurated split', () => {
  it('renders a row for a set, uncurated property', () => {
    selectNode({ inlineStyles: { gridAutoFlow: 'dense' } })
    render(<CustomPropertiesSection />)

    expect(screen.getByTestId('custom-property-row-gridAutoFlow')).toBeTruthy()
  })

  it('does not render a row for a curated property (it belongs to its own claiming section)', () => {
    selectNode({ inlineStyles: { opacity: '0.5' } })
    render(<CustomPropertiesSection />)

    expect(screen.queryByTestId('custom-property-row-opacity')).toBeNull()
  })
})

describe('CustomPropertiesSection (manifest wrapper) — round-trip', () => {
  it('editing the row value commits the new value', () => {
    selectNode({ inlineStyles: { gridAutoFlow: 'dense' } })
    render(<CustomPropertiesSection />)

    const input = screen.getByLabelText('grid-auto-flow value')
    fireEvent.change(input, { target: { value: 'column' } })

    expect(currentNode()?.inlineStyles?.gridAutoFlow).toBe('column')
  })
})

describe('CustomPropertiesSection (manifest wrapper) — locked properties', () => {
  it('reports a locked UNCURATED property', () => {
    selectNode({
      inlineStyles: { gridAutoFlow: 'dense' },
      codeProps: ['style:gridAutoFlow'],
    })
    render(<CustomPropertiesSection />)

    expect(screen.getByTestId('custom-properties-locked-properties-notice')).toBeTruthy()
  })

  it('does not report a locked CURATED property — that is its own section\'s notice', () => {
    selectNode({
      inlineStyles: { opacity: '0.5' },
      codeProps: ['style:opacity'],
    })
    render(<CustomPropertiesSection />)

    expect(screen.queryByTestId('custom-properties-locked-properties-notice')).toBeNull()
  })
})
