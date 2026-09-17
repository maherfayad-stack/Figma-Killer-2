/**
 * ColorsSection — the built-in design system's palette in the Assets panel
 * (DS-7).
 *
 * Four promises are pinned here, because each of them is invisible until it
 * breaks:
 *
 *  - the generated palette actually parses against its schema (a bad
 *    `alm:sync` would otherwise show an empty section and nothing else);
 *  - groups render in the design system's own order, not the JSON's accident
 *    and not alphabetically;
 *  - a designer finds a colour by family ("coral"), by name ("aqua-100") or
 *    by the hex they copied out of a mock ("#E9666F"); and
 *  - a click copies `var(--name)` — the string that goes into source — and an
 *    apply writes that same string through the inspector's own commit, so the
 *    panel and the inspector can never disagree about where a colour lands.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ColorsSection } from '@site/panels/AssetsPanel/ColorsSection'
import {
  COLOR_GROUP_ORDER,
  DESIGN_SYSTEM_COLOR_TOKENS,
  buildColorAssetItems,
  colorTokenTooltip,
  colorVarReference,
  groupColorItems,
  type ColorAssetItem,
} from '@site/panels/AssetsPanel/colorTokens'
import { rankAssets } from '@site/panels/AssetsPanel/rankAssets'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

const ITEMS = buildColorAssetItems()

function itemFor(name: string): ColorAssetItem {
  const item = ITEMS.find((entry) => entry.name === name)
  if (!item) throw new Error(`No colour token named ${name}`)
  return item
}

function ranked(items: readonly ColorAssetItem[]) {
  return items.map((item) => ({ item, score: 0, matchedKeyword: null }))
}

function names(query: string): string[] {
  return rankAssets(query, ITEMS).map((entry) => entry.item.name)
}

// ---------------------------------------------------------------------------
// The palette itself
// ---------------------------------------------------------------------------

describe('colorTokens', () => {
  it('parses the generated palette against its schema', () => {
    expect(DESIGN_SYSTEM_COLOR_TOKENS.length).toBeGreaterThan(100)
    for (const token of DESIGN_SYSTEM_COLOR_TOKENS) {
      expect(token.name.startsWith('--')).toBe(true)
      expect(token.light).not.toBe('')
      expect(token.dark).not.toBe('')
      expect(token.group).not.toBe('')
    }
  })

  it('knows every group the design system ships', () => {
    const groups = new Set(DESIGN_SYSTEM_COLOR_TOKENS.map((token) => token.group))
    for (const group of groups) {
      expect(COLOR_GROUP_ORDER).toContain(group)
    }
  })

  it('groups in the declared order, with an unknown family last and alphabetical', () => {
    const shuffled = [
      itemFor('--text-base-default'),
      itemFor('--color-coral-100'),
      itemFor('--color-metal'),
      { ...itemFor('--color-metal'), token: { ...itemFor('--color-metal').token, group: 'Zebra' } },
      { ...itemFor('--color-metal'), token: { ...itemFor('--color-metal').token, group: 'Aardvark' } },
      itemFor('--color-aqua-100'),
    ]

    expect(groupColorItems(shuffled).map(([group]) => group)).toEqual([
      'Neutral',
      'Aqua',
      'Coral',
      'Semantic text',
      'Aardvark',
      'Zebra',
    ])
  })

  it('copies a var() reference, not a hex', () => {
    expect(colorVarReference('--color-coral-100')).toBe('var(--color-coral-100)')
  })

  it('puts both values in the tooltip, and says so when they are the same', () => {
    expect(colorTokenTooltip(itemFor('--color-coral-100').token)).toBe(
      'Copy var(--color-coral-100) · Light #EF4550 · Dark #E9666F',
    )
    expect(colorTokenTooltip(itemFor('--color-white-static').token)).toBe(
      'Copy var(--color-white-static) · #FFFFFF in both themes',
    )
  })
})

// ---------------------------------------------------------------------------
// Search — the same `rankAssets` every other section rides
// ---------------------------------------------------------------------------

describe('colour token search', () => {
  it('finds a family by name', () => {
    const hits = names('coral')
    expect(hits).toContain('--color-coral-100')
    for (const name of hits) {
      const token = itemFor(name).token
      expect(`${name} ${token.group}`.toLowerCase()).toContain('coral')
    }
  })

  it('finds a token by its own name', () => {
    expect(names('aqua-100')[0]).toBe('--color-aqua-100')
  })

  it('finds every token holding a hex value pasted from a mock, in any case', () => {
    // A semantic token resolves to the raw token's value, so a hex genuinely
    // belongs to several names. The raw palette entry comes first (JSON order
    // survives an equal score), and nothing that does not hold the value is
    // in the list.
    for (const query of ['#E9666F', '#e9666f']) {
      const hits = names(query)
      expect(hits[0]).toBe('--color-coral-100')
      for (const name of hits) {
        const token = itemFor(name).token
        expect([token.light.toLowerCase(), token.dark.toLowerCase()]).toContain('#e9666f')
      }
    }
  })

  it('finds the semantic families by their group words', () => {
    const hits = names('border')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((name) => name.startsWith('--border-'))).toBe(true)
  })

  it('returns the whole palette for an empty query, in the JSON order', () => {
    expect(names('')).toEqual(DESIGN_SYSTEM_COLOR_TOKENS.map((token) => token.name))
  })
})

// ---------------------------------------------------------------------------
// The rendered section
// ---------------------------------------------------------------------------

describe('<ColorsSection>', () => {
  let written: string[] = []

  beforeEach(() => {
    written = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mock(async (text: string) => {
          written.push(text)
        }),
      },
    })
    useEditorStore.setState({
      site: null,
      activePageId: null,
      selectedNodeId: null,
      selectedNodeIds: [],
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  function selectNode(nodeOverrides: Parameters<typeof makeNode>[0] = {}) {
    const page = makePage({
      id: 'page-home',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root-home',
      nodes: {
        'root-home': makeNode({ id: 'root-home', moduleId: 'base.body', children: ['node-1'] }),
        'node-1': makeNode({ id: 'node-1', moduleId: 'base.container', ...nodeOverrides }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], files: [], visualComponents: [] }),
      activePageId: 'page-home',
      selectedNodeId: 'node-1',
      selectedNodeIds: ['node-1'],
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('renders nothing but a header while collapsed', () => {
    render(<ColorsSection ranked={ranked(ITEMS)} collapsed onToggle={() => {}} />)

    expect(screen.getByText('Colors')).toBeTruthy()
    expect(document.querySelectorAll('[data-color-token]')).toHaveLength(0)
  })

  it('lays the swatches out group by group, in the declared order', () => {
    render(
      <ColorsSection
        ranked={ranked([
          itemFor('--text-base-default'),
          itemFor('--color-coral-100'),
          itemFor('--color-metal'),
        ])}
        collapsed={false}
        onToggle={() => {}}
      />,
    )

    const rendered = [...document.querySelectorAll('[data-color-token]')].map((el) =>
      el.getAttribute('data-color-token'),
    )
    expect(rendered).toEqual(['--color-metal', '--color-coral-100', '--text-base-default'])
  })

  it('copies var(--name) on click', async () => {
    render(
      <ColorsSection
        ranked={ranked([itemFor('--color-coral-100')])}
        collapsed={false}
        onToggle={() => {}}
      />,
    )

    fireEvent.click(screen.getByLabelText('Copy var(--color-coral-100)'))

    await waitFor(() => expect(written).toEqual(['var(--color-coral-100)']))
  })

  it('offers no apply buttons, and says why, with nothing selected', () => {
    render(
      <ColorsSection
        ranked={ranked([itemFor('--color-coral-100')])}
        collapsed={false}
        onToggle={() => {}}
      />,
    )

    expect(screen.queryByLabelText('Apply --color-coral-100 to background')).toBeNull()
    expect(screen.getByText(/Select one layer/)).toBeTruthy()
  })

  it('refuses — visibly — a property the component computes in its own source', () => {
    selectNode({ codeProps: ['style:backgroundColor'] })
    render(
      <ColorsSection
        ranked={ranked([itemFor('--color-coral-100')])}
        collapsed={false}
        onToggle={() => {}}
      />,
    )

    const fill = screen.getByLabelText('Apply --color-coral-100 to background')
    expect(fill.hasAttribute('disabled') || fill.getAttribute('aria-disabled') === 'true').toBe(true)
    // Text is a different property on the same node — still writable.
    const text = screen.getByLabelText('Apply --color-coral-100 to text colour')
    expect(text.hasAttribute('disabled') || text.getAttribute('aria-disabled') === 'true').toBe(
      false,
    )

    fireEvent.click(fill)
    const node = useEditorStore
      .getState()
      .site?.pages.find((page) => page.id === 'page-home')?.nodes['node-1']
    expect(node?.inlineStyles?.backgroundColor).toBeUndefined()
  })

  it('applies a variable to the selected layer through the inspector commit', () => {
    selectNode()
    render(
      <ColorsSection
        ranked={ranked([itemFor('--color-coral-100')])}
        collapsed={false}
        onToggle={() => {}}
      />,
    )

    fireEvent.click(screen.getByLabelText('Apply --color-coral-100 to background'))
    fireEvent.click(screen.getByLabelText('Apply --color-coral-100 to text colour'))

    const node = useEditorStore
      .getState()
      .site?.pages.find((page) => page.id === 'page-home')?.nodes['node-1']
    expect(node?.inlineStyles?.backgroundColor).toBe('var(--color-coral-100)')
    expect(node?.inlineStyles?.color).toBe('var(--color-coral-100)')
  })
})
