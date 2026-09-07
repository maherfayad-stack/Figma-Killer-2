/**
 * Typography goes first for a text selection.
 *
 * The user's report: "when I select a text the typography controls are at the
 * top". `CLASS_STYLE_SECTIONS` itself stays a fixed registry — what changes is
 * the order it is RENDERED in, per selection, which is what these cases pin.
 */
import { describe, it, expect } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import { CLASS_STYLE_SECTIONS } from '@site/panels/PropertiesPanel/classStyleSections'
import {
  isTextNode,
  isTextSelection,
  orderStyleSections,
} from '@site/panels/PropertiesPanel/styleSectionOrder'
// Side-effect import: registers the base modules, so `registry.get('base.text')`
// can answer the `inlineTextEdit` question the predicate asks.
import '@modules/base'

function node(partial: Partial<PageNode> & { moduleId: string }): PageNode {
  return {
    id: 'n1',
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: [],
    ...partial,
  } as PageNode
}

describe('isTextNode', () => {
  it('is true for a childless text-bearing module', () => {
    expect(isTextNode(node({ moduleId: 'base.text', props: { tag: 'h1', text: 'Hi' } }))).toBe(true)
    expect(isTextNode(node({ moduleId: 'base.button', props: { label: 'Go' } }))).toBe(true)
  })

  it('is true for a childless element that renders text through its host tag', () => {
    // The parse produced a container for this `<li>` — it still renders text.
    expect(isTextNode(node({ moduleId: 'base.container', props: { tag: 'li' } }))).toBe(true)
    expect(isTextNode(node({ moduleId: 'base.container', props: { tag: 'SPAN' } }))).toBe(true)
  })

  it('is false for a box', () => {
    expect(isTextNode(node({ moduleId: 'base.container', props: { tag: 'div' } }))).toBe(false)
    expect(isTextNode(node({ moduleId: 'base.image', props: {} }))).toBe(false)
  })

  it('is false for a text-bearing node that renders children instead of its own text', () => {
    // `<a>` wrapping a card is a layout node, not a text layer — the same
    // clause the canvas inline editor uses before it starts a session.
    expect(isTextNode(node({ moduleId: 'base.link', children: ['c1'] }))).toBe(false)
    expect(isTextNode(node({ moduleId: 'base.container', props: { tag: 'li' }, children: ['c1'] }))).toBe(false)
  })
})

describe('isTextSelection', () => {
  const heading = node({ id: 'a', moduleId: 'base.text', props: { tag: 'h1' } })
  const paragraph = node({ id: 'b', moduleId: 'base.text', props: { tag: 'p' } })
  const box = node({ id: 'c', moduleId: 'base.container', props: { tag: 'div' } })

  it('is true when every selected node is a text layer', () => {
    expect(isTextSelection([heading])).toBe(true)
    expect(isTextSelection([heading, paragraph])).toBe(true)
  })

  it('is false for an empty or mixed selection', () => {
    expect(isTextSelection([])).toBe(false)
    expect(isTextSelection([heading, box])).toBe(false)
  })
})

describe('orderStyleSections', () => {
  const ids = (sections: ReadonlyArray<{ id: string }>) => sections.map((s) => s.id)

  it('leaves the registry order alone for a non-text selection', () => {
    expect(ids(orderStyleSections(CLASS_STYLE_SECTIONS, false))).toEqual(ids(CLASS_STYLE_SECTIONS))
  })

  it('lifts Typography to the front for a text selection', () => {
    const ordered = orderStyleSections(CLASS_STYLE_SECTIONS, true)
    expect(ordered[0].id).toBe('typography')
  })

  it('keeps every other section in its original relative order', () => {
    const ordered = ids(orderStyleSections(CLASS_STYLE_SECTIONS, true))
    const expected = ids(CLASS_STYLE_SECTIONS).filter((id) => id !== 'typography')
    expect(ordered.slice(1)).toEqual(expected)
    expect(ordered.length).toBe(CLASS_STYLE_SECTIONS.length)
  })

  it('is a no-op when Typography was filtered out by a style search', () => {
    const filtered = CLASS_STYLE_SECTIONS.filter((s) => s.id !== 'typography')
    expect(ids(orderStyleSections(filtered, true))).toEqual(ids(filtered))
  })
})
