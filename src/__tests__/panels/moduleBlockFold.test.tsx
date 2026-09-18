/**
 * The Module block's Law-3 fold (`STATE.md` `panel-41`).
 *
 * `docs/features/inspector.md` §1 Law 3 — "optional fields are *added*,
 * never pre-drawn" — was the one law the Module block did not follow: it
 * walked a module's whole `schema` and rendered a control per key whether or
 * not the user's source set it. This file pins the partition that fixes it,
 * and the three things it must NOT do:
 *
 *  1. A prop the source sets is resident, at rest, with no click.
 *  2. A prop the source does NOT set is behind the header's disclosure, and
 *     one click mounts it with the SAME `property-control-<key>` test id —
 *     a fold, not a deletion. (`tests/e2e/visual-builder.e2e.ts` and
 *     `reliability.e2e.ts` drive those ids directly.)
 *  3. A breakpoint override counts as SET even when the base value is
 *     absent. The user wrote it; hiding the only row that shows it would
 *     hide their own edit.
 *
 * A node INSERTED in the editor is seeded with `{ ...definition.defaults }`
 * (`src/core/page-tree/mutations.ts`), so every one of its schema keys is
 * present in its own `props` and nothing folds — the fold is a fact about
 * PARSED source, which is where pre-drawn rows come from.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { Page, PageNode } from '@core/page-tree'
import { renderModuleTabContent } from '@site/panels/PropertiesPanel/renderModuleTabContent'

afterEach(cleanup)

const DEFINITION = {
  id: 'base.image',
  name: 'Image',
  schema: {
    alt: { type: 'text', label: 'Alt text' },
    loading: {
      type: 'select',
      label: 'Loading',
      options: [
        { label: 'Lazy', value: 'lazy' },
        { label: 'Eager', value: 'eager' },
      ],
    },
    decoding: {
      type: 'select',
      label: 'Decoding',
      options: [
        { label: 'Async', value: 'async' },
        { label: 'Sync', value: 'sync' },
      ],
    },
  },
} as AnyModuleDefinition

function imageNode(props: Record<string, unknown>, overrides: Record<string, unknown> = {}): PageNode {
  return {
    id: 'src/pages/Home.tsx:4:6',
    moduleId: 'base.image',
    props,
    children: [],
    breakpointOverrides: Object.keys(overrides).length > 0 ? { mobile: overrides } : {},
    classIds: [],
  } as PageNode
}

const PAGE: Page = {
  id: 'page-home',
  slug: 'index',
  title: 'Home',
  rootNodeId: 'body',
  nodes: {},
}

function renderBlock(node: PageNode, overrideKeys: Set<string> = new Set()) {
  return render(
    <>
      {renderModuleTabContent({
        selectedNode: node,
        selectedNodeId: node.id,
        definition: DEFINITION,
        // What the engine hands the controls: the node's own props over the
        // module's defaults. Every schema key is "present" here, which is
        // exactly why the partition reads `selectedNode.props` instead.
        resolvedPropsForBreakpoint: { alt: '', loading: 'lazy', decoding: 'async', ...node.props },
        overrideKeys,
        activeDocument: null,
        activePage: PAGE,
        handleChange: () => undefined,
        handlePatch: () => undefined,
      })}
    </>,
  )
}

describe('the Module block folds what the source does not set', () => {
  it('keeps a prop the source sets resident, and folds the two it does not', () => {
    renderBlock(imageNode({ alt: 'A chip' }))

    expect(screen.getByTestId('property-control-alt')).toBeDefined()
    expect(screen.queryByTestId('property-control-loading')).toBeNull()
    expect(screen.queryByTestId('property-control-decoding')).toBeNull()

    const toggle = screen.getByTestId('module-more-properties-toggle')
    expect(toggle.textContent).toContain('2 more')
  })

  it('one click mounts every folded row under the same test id', () => {
    renderBlock(imageNode({ alt: 'A chip' }))
    fireEvent.click(screen.getByTestId('module-more-properties-toggle'))

    expect(screen.getByTestId('property-control-loading')).toBeDefined()
    expect(screen.getByTestId('property-control-decoding')).toBeDefined()
  })

  it('draws no disclosure at all when the source sets every prop', () => {
    renderBlock(imageNode({ alt: 'A chip', loading: 'eager', decoding: 'sync' }))

    expect(screen.queryByTestId('module-more-properties-toggle')).toBeNull()
    expect(screen.getByTestId('property-control-loading')).toBeDefined()
  })

  it('treats a breakpoint override as set — the user wrote it', () => {
    renderBlock(imageNode({ alt: 'A chip' }, { loading: 'eager' }), new Set(['loading']))

    expect(screen.getByTestId('property-control-loading')).toBeDefined()
    // Only `decoding` is left unset, so the fold still exists but holds one.
    expect(screen.getByTestId('module-more-properties-toggle').textContent).toContain('1 more')
  })
})
