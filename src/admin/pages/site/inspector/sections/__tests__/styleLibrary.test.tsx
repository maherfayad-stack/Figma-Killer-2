/**
 * CT-5 - the Text and Effects sections' style picker through happy-dom.
 *
 * Mounts the real sections against the store; the only stub is `fetch`, which
 * records what the picker posts to `/save` (the planner and the commit are the
 * real ones - `textStylesRealSource.test.ts` covers what the server does with
 * those edits). Asserts the menu lists the project's styles, each gesture posts
 * the edits the plan names with `restyle: true`, a control that cannot act says
 * why, and nothing renders for a multi-selection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { EffectsSection } from '../EffectsSection'
import { TextSection } from '../TextSection'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'pages/Home.tsx:7:8'
const OTHER_ID = 'pages/Home.tsx:8:8'
const ROOT_ID = 'root'

function rule(id: string, name: string, styles: Record<string, unknown>, extra: Partial<StyleRule> = {}): StyleRule {
  return { id, name, kind: 'class', selector: `.${name}`, order: 0, styles, contextStyles: {}, createdAt: 0, updatedAt: 0, ...extra }
}

const RULES: Record<string, StyleRule> = {
  heading: rule('heading', 'heading', { fontSize: '32px', fontWeight: '700', lineHeight: '1.2' }),
  display: rule('display', 'display', { fontSize: '48px', fontWeight: '800', lineHeight: '1' }),
  soft: rule('soft', 'soft', { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)' }),
  card: rule('card', 'card', { display: 'flex', fontSize: '14px' }),
}

let posted: Array<{ edits: Array<Record<string, unknown>> }> = []

beforeEach(() => {
  localStorage.clear()
  posted = []
  __resetToastBusForTests()
  resetStructuralCommitQueue()
  setStudioStyleRuleSources(
    Object.fromEntries(Object.values(RULES).map((r) => [r.id, { file: 'pages/Home.css', selector: r.selector }])),
    RULES,
  )
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/admin/api/studio/save')) {
      posted.push(JSON.parse(String(init?.body)) as (typeof posted)[number])
      // Nothing written: the picker's gesture is what is under test, not the resync.
      return new Response(JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ site: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
})

function select(overrides: Parameters<typeof makeNode>[0] = {}, ids: string[] = [NODE_ID]) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID, OTHER_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.text', props: { tag: 'p' }, ...overrides }),
      [OTHER_ID]: makeNode({ id: OTHER_ID, moduleId: 'base.text', props: { tag: 'p' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page], styleRules: RULES }),
    activePageId: 'page-1',
    selectedNodeId: ids[ids.length - 1]!,
    selectedNodeIds: ids,
    activeBreakpointId: 'desktop',
    activeConditionId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('the Text section style picker', () => {
  it('lists the project text styles and nothing that is a component class', () => {
    select({ inlineStyles: { fontSize: 40 } })
    render(<TextSection />)
    fireEvent.click(screen.getByTestId('text-styles-trigger'))
    expect(screen.getByTestId('style-option-heading')).toBeTruthy()
    expect(screen.getByTestId('style-option-display')).toBeTruthy()
    expect(screen.queryByTestId('style-option-card')).toBeNull()
    expect(screen.queryByTestId('style-option-soft')).toBeNull()
  })

  it('applying a style posts one restyle batch: the class on, the inline values it owns off', async () => {
    select({ inlineStyles: { fontSize: 40, color: 'tomato' } })
    render(<TextSection />)
    fireEvent.click(screen.getByTestId('text-styles-trigger'))
    fireEvent.click(screen.getByTestId('style-option-heading'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([
      { kind: 'class', nodeId: NODE_ID, add: [{ kind: 'literal', token: 'heading' }], remove: [], restyle: true },
      { kind: 'style', nodeId: NODE_ID, style: {}, remove: ['fontSize'] },
    ])
  })

  it('shows the applied style as a chip and detaching posts the class off and the values inline', async () => {
    select({ classIds: ['heading'] })
    render(<TextSection />)
    expect(screen.getByTestId('text-style-applied').textContent).toContain('heading')
    fireEvent.click(screen.getByTestId('text-style-detach-chip'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([
      { kind: 'class', nodeId: NODE_ID, add: [], remove: [{ kind: 'literal', token: 'heading' }], restyle: true },
      { kind: 'style', nodeId: NODE_ID, style: { fontSize: '32px', fontWeight: '700', lineHeight: '1.2' } },
    ])
  })

  it('create style from selection is disabled, with the reason, when the layer sets no typography', () => {
    select()
    render(<TextSection />)
    fireEvent.click(screen.getByTestId('text-styles-trigger'))
    // A disabled button with a tooltip stays focusable and says `aria-disabled` (the reason is its tooltip).
    expect(screen.getByTestId('text-style-create').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('text-style-create'))
    expect(screen.queryByTestId('text-style-name')).toBeNull()
  })

  it('create style from selection names the class and posts the rule, the class and the inline strip', async () => {
    select({ inlineStyles: { fontSize: 40, fontWeight: 700 } })
    render(<TextSection />)
    fireEvent.click(screen.getByTestId('text-styles-trigger'))
    fireEvent.click(screen.getByTestId('text-style-create'))
    fireEvent.change(screen.getByTestId('text-style-name'), { target: { value: 'Page title' } })
    expect(screen.getByText('Saved as .text-page-title in your stylesheet.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('text-style-name-submit'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([
      {
        kind: 'css',
        op: 'insert',
        nodeId: 'css:insert:pages/Home.css#.text-page-title',
        file: 'pages/Home.css',
        selector: '.text-page-title',
        declarations: { 'font-size': '40px', 'font-weight': '700' },
      },
      { kind: 'class', nodeId: NODE_ID, add: [{ kind: 'literal', token: 'text-page-title' }], remove: [], restyle: true },
      { kind: 'style', nodeId: NODE_ID, style: {}, remove: ['fontSize', 'fontWeight'] },
    ])
  })

  it('a taken name is refused next to the field and nothing is posted', async () => {
    select({ inlineStyles: { fontSize: 40 }, classIds: [] })
    useEditorStore.setState((state) => {
      state.site!.styleRules['text-taken'] = rule('text-taken', 'text-taken', { fontSize: '10px', fontWeight: '400' })
    })
    render(<TextSection />)
    fireEvent.click(screen.getByTestId('text-styles-trigger'))
    fireEvent.click(screen.getByTestId('text-style-create'))
    fireEvent.change(screen.getByTestId('text-style-name'), { target: { value: 'taken' } })
    fireEvent.click(screen.getByTestId('text-style-name-submit'))
    expect((await screen.findByRole('alert')).textContent).toContain('text-taken already exists')
    expect(posted).toHaveLength(0)
  })

  it('offers nothing for a multi-selection', () => {
    select({ inlineStyles: { fontSize: 40 } }, [OTHER_ID, NODE_ID])
    render(<TextSection />)
    expect(screen.queryByTestId('text-styles-trigger')).toBeNull()
  })
})

describe('the Effects section style picker', () => {
  it('lists effect styles even when the layer has no effect yet, and applying one posts the class', async () => {
    select()
    render(<EffectsSection />)
    fireEvent.click(screen.getByTestId('effect-styles-trigger'))
    expect(screen.queryByTestId('style-option-heading')).toBeNull()
    fireEvent.click(screen.getByTestId('style-option-soft'))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.edits).toEqual([
      { kind: 'class', nodeId: NODE_ID, add: [{ kind: 'literal', token: 'soft' }], remove: [], restyle: true },
    ])
  })
})
