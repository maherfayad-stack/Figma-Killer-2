/**
 * Editing copy that was RESOLVED from an expression.
 *
 * `<span className="bc-card__tag">{c.hotelsTag}</span>` is the shape most of an
 * imported app's copy takes. The node is source-locked, because writing an edited
 * string back over `{c.hotelsTag}` would delete the i18n binding — so for a long
 * while the panel showed the text and silently threw away every keystroke.
 *
 * The resolution is that the JSX is not the only writeback target. The string the
 * expression reads is an ordinary literal in a real file
 * (`hotelsTag: 'Exclusive rates on hotels'` in `translations.js`), the parser
 * records exactly where (`PageNode.textOrigin`), and the edit is routed there.
 *
 * Three gates have to agree for that to work, and they are tested together here
 * because disagreement is the failure mode: the store must ADMIT the write, the
 * panel must OFFER the control, and neither may loosen for anything else.
 */
import { describe, expect, it } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import { propLockReason } from '@site/panels/PropertiesPanel/renderModuleTabContent'
import '@modules/base'
import { useEditorStore } from '@site/store/store'

const ORIGIN = { rel: 'src/i18n/translations.js', line: 142, col: 18 }

function textNode(overrides: Partial<PageNode> = {}): PageNode {
  return {
    id: 'src/screens/BookingConfirmationScreen.jsx:65:16',
    moduleId: 'base.text',
    props: { text: 'Exclusive rates on hotels', tag: 'span' },
    children: [],
    ...overrides,
  } as PageNode
}

describe('the properties panel on resolved text', () => {
  it('offers the text control when the text has a writable origin', () => {
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })

    expect(propLockReason(node, 'text')).toBeUndefined()
  })

  it('still locks every OTHER prop on that node', () => {
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })

    // Only the text has a known literal behind it. `tag` came from the JSX, which
    // is still not a writeback target on a locked node.
    expect(propLockReason(node, 'tag')).toBe('value from c.hotelsTag')
  })

  it('locks the text too when there is no origin', () => {
    // A computed value — a template literal, a concatenation — has no single
    // literal to rewrite, so the parser records no origin and nothing pretends.
    const node = textNode({ locked: true, lockReason: 'value from `${count} left`' })

    expect(propLockReason(node, 'text')).toBe('value from `${count} left`')
  })

  it('leaves an unlocked node alone entirely', () => {
    const node = textNode()

    expect(propLockReason(node, 'text')).toBeUndefined()
    expect(propLockReason(node, 'tag')).toBeUndefined()
  })

  it('does not unlock a prop that merely shares a name with another module`s text prop', () => {
    // `base.image` declares no `inlineTextEdit`, so no prop on it is text.
    const node = textNode({
      moduleId: 'base.image',
      props: { src: '/x.png', alt: 'x' },
      locked: true,
      lockReason: 'value from hero',
      textOrigin: ORIGIN,
    })

    expect(propLockReason(node, 'alt')).toBe('value from hero')
    expect(propLockReason(node, 'src')).toBe('value from hero')
  })
})

// ---------------------------------------------------------------------------
// The store gate — `updateNodeProps` is what actually admits or refuses
// ---------------------------------------------------------------------------

describe('the store gate on resolved text', () => {
  /** A one-page site whose single node is the locked `{c.hotelsTag}` span. */
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

  it('applies a text-only patch when the node has a writable origin', () => {
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'Members-only hotel rates' })

    expect(currentText(node.id)).toBe('Members-only hotel rates')
  })

  it('refuses the same patch when the node has no origin', () => {
    const node = textNode({ locked: true, lockReason: 'value from `${n} left`' })
    seedSite(node)

    useEditorStore.getState().updateNodeProps(node.id, { text: 'nope' })

    expect(currentText(node.id)).toBe('Exclusive rates on hotels')
  })

  it('refuses a patch that reaches beyond the text prop', () => {
    const node = textNode({ locked: true, lockReason: 'value from c.hotelsTag', textOrigin: ORIGIN })
    seedSite(node)

    // `tag` has no honest target on a locked node, so the WHOLE patch is refused
    // rather than half-applied — a half-applied patch is a canvas that disagrees
    // with the file it claims to mirror.
    useEditorStore.getState().updateNodeProps(node.id, { text: 'new', tag: 'p' })

    expect(currentText(node.id)).toBe('Exclusive rates on hotels')
  })
})
