/**
 * fontWeight select options reflect the installed variants for the active
 * font token.
 *
 * Ported onto `TextSection` (P3, `STATE.md` `panel-25`, item 9) — the old
 * `StyleSectionsEditor` this test drove is deleted; `fontWeightOptions.ts`
 * itself is unchanged (panel-25's own mapping table: "kept, reused") and is
 * still read by `ClassPropertyRow.tsx`, which `TextSection`'s `fontWeight`
 * row renders through the same as every other migrated section's rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { FontEntry } from '@core/fonts'
import { TextSection } from '@site/inspector/sections/TextSection'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

const inter: FontEntry = {
  id: 'font-inter',
  source: 'google',
  family: 'Inter',
  variants: ['300', '400', '700', '900'],
  subsets: ['latin'],
  files: [
    { variant: '300', subset: 'latin', path: '/uploads/fonts/inter/300-latin.woff2', format: 'woff2' },
    { variant: '400', subset: 'latin', path: '/uploads/fonts/inter/400-latin.woff2', format: 'woff2' },
    { variant: '700', subset: 'latin', path: '/uploads/fonts/inter/700-latin.woff2', format: 'woff2' },
    { variant: '900', subset: 'latin', path: '/uploads/fonts/inter/900-latin.woff2', format: 'woff2' },
  ],
  category: 'Sans Serif',
  createdAt: 1,
  updatedAt: 1,
}

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

afterEach(cleanup)

function selectTextNode(inlineStyles: Record<string, unknown>) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.text', props: { tag: 'p' }, inlineStyles }),
    },
  })
  useEditorStore.setState({
    site: makeSite({
      pages: [page],
      settings: {
        shortcuts: {},
        fonts: {
          items: [inter],
          tokens: [
            {
              id: 'token-primary',
              name: 'Primary',
              variable: 'font-primary',
              familyId: inter.id,
              fallback: 'sans-serif',
              order: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function fontWeightOptionValues(): string[] {
  const row = screen.getByTestId('css-property-row-fontWeight')
  const select = row.querySelector('select')
  expect(select).toBeInstanceOf(HTMLSelectElement)

  return Array.from(select?.options ?? [], (option) => option.value)
}

describe('font weight style options', () => {
  it('reflects the installed variants for the active font token', () => {
    selectTextNode({ fontFamily: 'var(--font-primary)' })
    render(<TextSection />)

    expect(fontWeightOptionValues()).toEqual(['', '300', '400', '700', '900'])
  })

  it('uses the default body font token when no explicit font family is set', () => {
    selectTextNode({})
    render(<TextSection />)

    expect(fontWeightOptionValues()).toEqual(['', '300', '400', '700', '900'])
  })
})
