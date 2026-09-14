/**
 * ComponentSection — E2.5 integration proof: does the real component
 * actually call E1's catalog and drive its row set from it? (The
 * integration-gap protocol: a unit-tested pure function with no wired
 * caller is not "done" — see `componentCallSiteRows.test.ts` for the pure
 * row-building contract this file proves is REACHED from a rendered
 * `studio.instance` selection.)
 *
 * Ported from `src/__tests__/panels/instanceCallSiteView.test.tsx`
 * (`STATE.md` `panel-25`, P3 item 11 — Studio extras): the component no
 * longer takes `{ nodeId, node }` props — it reads `useSelectionModel()`
 * itself, so the tests select the node through the store instead of
 * passing props directly, the same shift every migrated section's own test
 * suite already made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComponentSection } from '../ComponentSection'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'

const originalFetch = globalThis.fetch

function seedInstance() {
  const owner = makeNode({
    id: 'src/pages/Home.tsx:5:3',
    moduleId: 'studio.instance',
    props: {
      componentName: 'Card',
      source: 'local',
      sourceFile: 'src/components/Card.tsx',
      callSiteProps: { title: 'Hello' },
    },
  })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [owner.id] })
  const page = makePage({ id: 'page-1', nodes: { root, [owner.id]: owner } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: owner.id,
    _nodeIdToPageIds: new Map([
      [owner.id, [page.id]],
      [root.id, [page.id]],
    ]),
  } as Parameters<typeof useEditorStore.setState>[0])
  return owner
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    _nodeIdToPageIds: new Map(),
  } as Parameters<typeof useEditorStore.setState>[0])
  // See `SlotControl.test.tsx`'s identical reset — the catalog fetch is
  // cached at module scope across test FILES in the same process.
  invalidateLocalComponentCatalog()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({
          components: [
            {
              name: 'Card',
              file: 'src/components/Card.tsx',
              exportName: 'default',
              isDefaultExport: true,
              props: [
                { name: 'title', kind: { kind: 'string' }, required: true },
                { name: 'variant', kind: { kind: 'enum', values: ['primary', 'ghost'] }, required: false },
              ],
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('ComponentSection (E2.5 — catalog-driven Component section)', () => {
  it('renders null when no node is selected', () => {
    const { container } = render(<ComponentSection />)
    expect(container.firstChild).toBeNull()
  })

  it('gives a declared-but-unset prop a row, sourced from the fetched catalog', async () => {
    seedInstance()
    render(<ComponentSection />)

    await waitFor(() => expect(screen.getByTestId('instance-call-site-prop-variant')).toBeTruthy())
    // A named union alias (`enum` PropKind) renders a real dropdown — a
    // `<select>` element — not a free-text box.
    const row = screen.getByTestId('instance-call-site-prop-variant')
    expect(row.querySelector('select')).not.toBeNull()
  })

  it('renders the Component section title', async () => {
    seedInstance()
    render(<ComponentSection />)

    await waitFor(() => expect(screen.getByText('Component')).toBeTruthy())
  })

  it('writing the declared-but-unset prop actually updates the node', async () => {
    const owner = seedInstance()
    const user = userEvent.setup()
    render(<ComponentSection />)

    await waitFor(() => expect(screen.getByTestId('instance-call-site-prop-variant')).toBeTruthy())
    const select = screen.getByTestId('instance-call-site-prop-variant').querySelector('select')!
    await user.selectOptions(select, 'ghost')

    await waitFor(() => {
      const updated = useEditorStore.getState().site?.pages[0]?.nodes[owner.id]
      const callSiteProps = (updated?.props as { callSiteProps?: Record<string, unknown> } | undefined)?.callSiteProps
      expect(callSiteProps?.variant).toBe('ghost')
    })
  })
})
