/**
 * Editing an imported node's values — the per-PROP rule.
 *
 * `<span className="bc-card__tag">{c.hotelsTag}</span>` inside
 * `{isMember && …}` is the shape most of an imported app's UI takes, and it used
 * to be completely dead in the editor. Both halves were gated on the node's
 * `lockReason`, so:
 *
 *   - the structural lock (a ternary chose this element) refused EVERY prop,
 *     including the plain literal attributes sitting right there in the source
 *   - the resolved-value lock (`{c.hotelsTag}`) refused every OTHER prop on the
 *     node too, because the lock was recorded once for the whole node
 *
 * On one real imported app that left 42% of nodes with a properties panel full of
 * live-looking inputs that threw away every keystroke.
 *
 * The rule now lives in `PageNode.codeProps` — the props that genuinely have no
 * writable target — and `lockReason` is back to describing structure only. These
 * tests pin the three surfaces that must agree on it: the store, which admits or
 * refuses the write; the panel, which decides whether to offer a control; and the
 * save adapter, which turns a change into a source edit.
 */
import { describe, expect, it } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import {
  isPropWritableToSource,
  isPropPatchWritableToSource,
  isStyleWritableToSource,
  hasWritableSourceLocation,
  styleValueKey,
} from '@core/page-tree'
import { propLockReason } from '@site/panels/PropertiesPanel/renderModuleTabContent'
import '@modules/base'
import { useEditorStore } from '@site/store/store'

const ORIGIN = { rel: 'src/i18n/translations.js', line: 142, col: 18 }
const LOC = 'src/screens/BookingConfirmationScreen.jsx:65:16'

function textNode(overrides: Partial<PageNode> = {}): PageNode {
  return {
    id: LOC,
    moduleId: 'base.text',
    props: { text: 'Exclusive rates on hotels', tag: 'span' },
    children: [],
    ...overrides,
  } as PageNode
}

describe('the properties panel on an imported node', () => {
  it('offers every literal prop on a node locked only for its STRUCTURE', () => {
    // `{cond && <span title="…">}` — the branch decides whether this renders, not
    // what its attributes say. Both are real literals at a real line and column.
    const node = textNode({
      locked: true,
      lockReason: 'one branch of several — chosen in code',
      props: { text: 'Exclusive rates on hotels', title: 'Hotels' },
    })

    expect(propLockReason(node, 'text')).toBeUndefined()
    expect(propLockReason(node, 'title')).toBeUndefined()
  })

  it('locks exactly the props that came from an expression, not their siblings', () => {
    const node = textNode({
      locked: true,
      lockReason: 'value from c.hotelsTag',
      props: { text: 'Exclusive rates on hotels', title: 'Hotels' },
      codeProps: ['text'],
    })

    expect(propLockReason(node, 'text')).toBe('value from c.hotelsTag')
    // The sibling literal was never the reason for the lock.
    expect(propLockReason(node, 'title')).toBeUndefined()
  })

  it('offers a resolved text whose literal origin is known', () => {
    // Resolved from `{c.hotelsTag}`, but the string it reads is an ordinary
    // literal in `translations.js`, so `studio-sync` leaves it out of codeProps.
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })

    expect(propLockReason(node, 'text')).toBeUndefined()
  })

  it('locks a computed text, which has no single literal to rewrite', () => {
    const node = textNode({
      locked: true,
      lockReason: 'value from `${count} left`',
      codeProps: ['text'],
    })

    expect(propLockReason(node, 'text')).toBe('value from `${count} left`')
  })

  it('leaves a node with no source provenance entirely alone', () => {
    const node = textNode()

    expect(propLockReason(node, 'text')).toBeUndefined()
    expect(propLockReason(node, 'tag')).toBeUndefined()
  })

  it('names a code-valued prop even when the node has no structural lock', () => {
    // One resolved attribute among literals — nothing structural about it.
    const node = textNode({ codeProps: ['title'] })

    expect(propLockReason(node, 'title')).toBe('set in code')
    expect(propLockReason(node, 'text')).toBeUndefined()
  })
})

describe('the writability rule itself', () => {
  it('reads inline-style entries under the style: prefix', () => {
    const node = textNode({ codeProps: [styleValueKey('width')] })

    expect(isStyleWritableToSource(node, 'width')).toBe(false)
    expect(isStyleWritableToSource(node, 'color')).toBe(true)
    // The prefix is a namespace, not a prop called `width`.
    expect(isPropWritableToSource(node, 'width')).toBe(true)
  })

  it('refuses a whole patch when any single key is code-valued', () => {
    const node = textNode({ codeProps: ['title'] })

    // Half-applying would leave the canvas disagreeing with the file it mirrors.
    expect(isPropPatchWritableToSource(node, { text: 'a', title: 'b' })).toBe(false)
    expect(isPropPatchWritableToSource(node, { text: 'a' })).toBe(true)
  })

  it('treats a `.map` iteration id as having no writable location', () => {
    expect(hasWritableSourceLocation('src/screens/Home.jsx:70:21')).toBe(true)
    expect(hasWritableSourceLocation('src/screens/Home.jsx:70:21#2')).toBe(false)
    // An inlined component id resolves to the component's own file.
    expect(hasWritableSourceLocation('pages/Home.jsx:77:19~components/Icon.jsx:3:6')).toBe(true)
    // A CMS nanoid is not source-derived at all.
    expect(hasWritableSourceLocation('V1StGXR8Z5jdHi6BmyT')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The store gate — `updateNodeProps` is what actually admits or refuses
// ---------------------------------------------------------------------------

describe('the store gate on an imported node', () => {
  /** A one-page site whose single node is the imported span. */
  function seedSite(node: PageNode): void {
    useEditorStore.setState({
      site: {
        id: 'studio',
        name: 'Studio',
        pages: [{
          id: 'page',
          name: 'Page',
          slug: 'page',
          rootNodeId: node.id,
          nodes: { [node.id]: node },
        }],
        styleRules: {},
      } as never,
      activePageId: 'page',
      activeDocument: null,
      selectedNodeId: node.id,
      selectedNodeIds: [node.id],
      _historyPast: [],
      _historyFuture: [],
    })
  }

  const currentText = (id: string): unknown =>
    useEditorStore.getState().site?.pages[0]?.nodes[id]?.props.text

  it('applies a text edit on a node locked only for its structure', () => {
    const node = textNode({ locked: true, lockReason: 'one branch of several — chosen in code' })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'Members-only hotel rates' })

    expect(currentText(node.id)).toBe('Members-only hotel rates')
  })

  it('applies a text edit routed to a known literal origin', () => {
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'Members-only hotel rates' })

    expect(currentText(node.id)).toBe('Members-only hotel rates')
  })

  it('refuses a text edit when the text is code with no origin', () => {
    const node = textNode({ locked: true, lockReason: 'value from `${n} left`', codeProps: ['text'] })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'nope' })

    expect(currentText(node.id)).toBe('Exclusive rates on hotels')
  })

  it('refuses the whole patch when one key of it is code-valued', () => {
    const node = textNode({
      locked: true,
      lockReason: 'value from c.hotelsTag',
      textOrigin: ORIGIN,
      codeProps: ['tag'],
    })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'new', tag: 'p' })

    expect(currentText(node.id)).toBe('Exclusive rates on hotels')
  })

  it('still refuses an inline-style edit on a `.map` row', () => {
    const node = textNode({
      id: `${LOC}#2`,
      locked: true,
      lockReason: 'item 3 of DEALS',
      inlineStyles: { color: 'red' },
      codeProps: ['text', 'tag', styleValueKey('color')],
    })
    seedSite(node)

    useEditorStore.getState().setNodeInlineStyles(node.id, { color: 'blue' })

    expect(useEditorStore.getState().site?.pages[0]?.nodes[node.id]?.inlineStyles?.color).toBe('red')
  })
})
