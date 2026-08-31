/**
 * SlotControl — the `node`-kind PropKind affordance (WS-3.4/E2.3's captured
 * slot children). Before this control existed at all, a `node`-kind prop
 * rendered no row. E2.5 adds the "Add"/"Add another" write path
 * (`insert-slot`, E2.4) on top of the pre-existing "Edit contents"
 * navigation — pre-checked with `explainStructuralConstraint` so a refused
 * write shows disabled-with-a-reason, never a failed click.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SlotControl } from '@site/property-controls/SlotControl'
import { studioSlotValue } from '@core/utils/studioSlotSentinel'
import { useEditorStore } from '@site/store/store'
import { rebuildNodeIndexes, type NodeIndexes } from '@site/store/slices/site/nodeIndex'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage, makeSite } from '../fixtures'

const originalFetch = globalThis.fetch

function seedSiteWithOwner(ownerId: string) {
  const owner = makeNode({
    id: ownerId,
    moduleId: 'studio.instance',
    props: {
      componentName: 'Card',
      source: 'local',
      sourceFile: 'src/components/Card.tsx',
      callSiteProps: {},
    },
  })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [owner.id] })
  const page = makePage({ nodes: { root, [owner.id]: owner } })
  const site = makeSite({ pages: [page] })
  const indexes: NodeIndexes = { nodeIdToPageIds: new Map(), textOriginKeyToCount: new Map(), inlineTailToCount: new Map() }
  rebuildNodeIndexes(indexes, site)
  useEditorStore.setState({
    site,
    _nodeIdToPageIds: indexes.nodeIdToPageIds,
    _textOriginKeyToCount: indexes.textOriginKeyToCount,
    _inlineTailToCount: indexes.inlineTailToCount,
  } as Parameters<typeof useEditorStore.setState>[0])
  return owner
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    _nodeIdToPageIds: new Map(),
    _textOriginKeyToCount: new Map(),
    _inlineTailToCount: new Map(),
    selectedNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  // The catalog fetch is cached at module scope (deliberately — see
  // `componentCatalog.ts`'s own doc), which means it survives across test
  // FILES in the same `bun test` process unless explicitly reset here.
  invalidateLocalComponentCatalog()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('SlotControl', () => {
  it('renders an "Edit contents" button for a real slot sentinel', () => {
    render(
      <SlotControl
        propKey="icon"
        value={studioSlotValue('pages/Home.jsx:5:3')}
        label="Icon"
        onChange={() => {}}
      />,
    )
    expect(screen.getByTestId('slot-control-icon').textContent).toContain('Edit contents')
  })

  it('clicking "Edit contents" selects the slot node in the editor store', async () => {
    const user = userEvent.setup()
    const nodeId = 'pages/Home.jsx:5:3'
    render(
      <SlotControl
        propKey="icon"
        value={studioSlotValue(nodeId)}
        label="Icon"
        onChange={() => {}}
      />,
    )
    await user.click(screen.getByTestId('slot-control-icon'))
    expect(useEditorStore.getState().selectedNodeId).toBe(nodeId)
  })

  it('offers Add and nothing else for a non-sentinel value', () => {
    render(<SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} />)
    // No "Edit contents" and no "Replace" — there is nothing to edit or
    // replace. The Add button is the empty state; a sentence saying the slot
    // is empty only repeats what the absent buttons already say.
    expect(screen.queryByTestId('slot-control-icon')).toBeNull()
    expect(screen.queryByTestId('slot-control-icon-replace')).toBeNull()
    expect(screen.getByTestId('slot-control-icon-add')).toBeTruthy()
  })

  it('disables Add when there is no owner node to resolve', () => {
    render(<SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} />)
    const add = screen.getByTestId('slot-control-icon-add')
    expect(add.getAttribute('aria-disabled')).toBe('true')
  })

  it('enables Add for a declared-but-empty slot on an ordinary, writable owner', () => {
    const owner = seedSiteWithOwner('src/pages/Home.tsx:5:3')
    render(
      <SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} ownerNodeId={owner.id} />,
    )
    const add = screen.getByTestId('slot-control-icon-add')
    expect(add.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('disables Add with a reason when the owner sits inside a .map row', () => {
    const owner = seedSiteWithOwner('src/pages/Home.tsx:5:3#0')
    render(
      <SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} ownerNodeId={owner.id} />,
    )
    const add = screen.getByTestId('slot-control-icon-add')
    expect(add.getAttribute('aria-disabled')).toBe('true')
  })

  it('opening Add fetches the project catalog and writes an insert-slot edit naming the call site on pick', async () => {
    const owner = seedSiteWithOwner('src/pages/Home.tsx:5:3')
    const saveBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/admin/api/studio/components')) {
        return new Response(
          JSON.stringify({
            components: [
              { name: 'Icon', file: 'src/components/Icon.tsx', exportName: 'default', isDefaultExport: true, props: [] },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/admin/api/studio/save')) {
        if (init?.body) saveBodies.push(JSON.parse(String(init.body)))
        return new Response(
          JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }) as typeof fetch

    const user = userEvent.setup()
    render(
      <SlotControl propKey="icon" value={undefined} label="Icon" onChange={() => {}} ownerNodeId={owner.id} />,
    )
    await user.click(screen.getByTestId('slot-control-icon-add'))
    await waitFor(() => expect(screen.getByTestId('slot-control-icon-candidate-Icon')).toBeTruthy())
    await user.click(screen.getByTestId('slot-control-icon-candidate-Icon'))

    await waitFor(() => expect(saveBodies.length).toBeGreaterThan(0))
    const body = saveBodies[0] as { edits: { kind: string; nodeId: string; propName: string; node: { name: string; importSpecifier: string } }[] }
    expect(body.edits).toHaveLength(1)
    expect(body.edits[0]).toEqual({
      kind: 'insert-slot',
      nodeId: owner.id,
      propName: 'icon',
      node: { name: 'Icon', importSpecifier: '../components/Icon' },
      // An EMPTY slot's "Add" appends — there is nothing to replace. The
      // "Replace" affordance only exists once the slot is filled.
      mode: 'append',
    })
  })
})
