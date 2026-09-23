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
 *
 * P2-G adds the section's shape: one title row naming the instance
 * ("Card · Local") with Detach and Swap as icon buttons (UX-4), no mount at
 * all under a multi-selection (UX-14), and a Detach refusal that offers
 * "duplicate it instead" for exactly the reasons `explainDetachConstraint`
 * names — one list, not a second copy here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComponentSection } from '../ComponentSection'
import { INSPECTOR_SECTIONS } from '..'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'

const originalFetch = globalThis.fetch

const OWNER_ID = 'src/pages/Home.tsx:5:3'
const SIBLING_ID = 'src/pages/Home.tsx:6:3'

/** The refusal the mocked `/save` answers a `detach` edit with. */
let detachRefusal: { reason: string; message: string } | null = null

function instanceNode(id: string, title: string) {
  return makeNode({
    id,
    moduleId: 'studio.instance',
    props: {
      componentName: 'Card',
      source: 'local',
      sourceFile: 'src/components/Card.tsx',
      callSiteProps: { title },
    },
  })
}

/** Two instances of `Card` on one page; `owner` is selected (and is the anchor). */
function seedInstance(options: { multiSelect?: boolean } = {}) {
  const owner = instanceNode(OWNER_ID, 'Hello')
  const sibling = instanceNode(SIBLING_ID, 'Other')
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [owner.id, sibling.id] })
  const page = makePage({ id: 'page-1', nodes: { root, [owner.id]: owner, [sibling.id]: sibling } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: owner.id,
    selectedNodeIds: options.multiSelect ? [sibling.id, owner.id] : [owner.id],
    _nodeIdToPageIds: new Map([
      [owner.id, [page.id]],
      [sibling.id, [page.id]],
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
    selectedNodeIds: [],
    _nodeIdToPageIds: new Map(),
  } as Parameters<typeof useEditorStore.setState>[0])
  // See `SlotControl.test.tsx`'s identical reset — the catalog fetch is
  // cached at module scope across test FILES in the same process.
  invalidateLocalComponentCatalog()
  detachRefusal = null
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/admin/api/studio/save')) {
      return new Response(
        JSON.stringify({
          ok: true,
          written: 0,
          skipped: 0,
          shifted: false,
          sharedComponents: false,
          refusals: detachRefusal ? [{ nodeId: OWNER_ID, kind: 'detach', ...detachRefusal }] : [],
        }),
        { status: 200 },
      )
    }
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

  it('a text prop writes the call site once, on commit — not per keystroke (UX-16)', async () => {
    const owner = seedInstance()
    const user = userEvent.setup()
    render(<ComponentSection />)

    const row = await screen.findByTestId('instance-call-site-prop-title')
    const input = row.querySelector('input')!
    await user.clear(input)
    await user.type(input, 'Welcome')
    const readTitle = () =>
      (useEditorStore.getState().site?.pages[0]?.nodes[owner.id]?.props as { callSiteProps?: Record<string, unknown> })
        .callSiteProps?.title
    expect(readTitle()).toBe('Hello')
    await user.keyboard('{Enter}')
    expect(readTitle()).toBe('Welcome')
  })
})

describe('ComponentSection — one title row (P2-G, UX-4)', () => {
  it('titles the section with the instance itself, "Card · Local", not a generic "Component" over a second name band', async () => {
    seedInstance()
    render(<ComponentSection />)

    await waitFor(() => expect(screen.getByText('Card')).toBeTruthy())
    expect(screen.getByTestId('instance-source-badge').textContent).toBe('Local')
    // One title, not two: the old section printed "Component" and then the
    // component name again in a filled band below it.
    expect(screen.queryByText('Component')).toBeNull()
    expect(screen.getAllByText('Card')).toHaveLength(1)
  })

  it('puts Detach and Swap in the title row as labelled icon buttons', async () => {
    seedInstance()
    render(<ComponentSection />)

    const detach = await screen.findByTestId('instance-detach-button')
    const swap = screen.getByTestId('instance-swap-button')
    expect(detach.getAttribute('aria-label')).toBe('Detach instance')
    expect(swap.getAttribute('aria-label')).toBe('Swap instance')
    expect(detach.textContent?.trim()).toBe('')
    expect(swap.textContent?.trim()).toBe('')
  })

  it('opens the Swap picker as a popover from the title row', async () => {
    seedInstance()
    const user = userEvent.setup()
    render(<ComponentSection />)

    const swap = await screen.findByTestId('instance-swap-button')
    expect(screen.queryByTestId('instance-swap-picker')).toBeNull()
    await user.click(swap)
    expect(await screen.findByTestId('instance-swap-picker')).toBeTruthy()
    // Re-queried: `Button` re-mounts its element when its tooltip is
    // suppressed for an open popup.
    expect(screen.getByTestId('instance-swap-button').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ComponentSection — hidden under multi-select (P2-G, UX-14)', () => {
  it("renders nothing when two instances are selected, instead of the anchor's values", () => {
    seedInstance({ multiSelect: true })
    const { container } = render(<ComponentSection />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('instance-detach-button')).toBeNull()
  })

  it('the manifest entry applies to one instance and not to a multi-selection', () => {
    const entry = INSPECTOR_SECTIONS.find((section) => section.id === 'component')!
    type Selection = Parameters<typeof entry.appliesTo>[0]
    const single = { isMultiSelect: false, selectedNode: { moduleId: 'studio.instance' } } as unknown as Selection
    const multi = { isMultiSelect: true, selectedNode: { moduleId: 'studio.instance' } } as unknown as Selection
    expect(entry.appliesTo(single)).toBe(true)
    expect(entry.appliesTo(multi)).toBe(false)
  })
})

describe('ComponentSection — Detach refusals surface as before (P1-E1)', () => {
  it("shows the parser's sentence and offers a duplicate for a reason a copy would fix", async () => {
    seedInstance()
    detachRefusal = { reason: 'spread-ambiguous', message: 'Card spreads its props, so detach cannot tell which binding wins.' }
    const user = userEvent.setup()
    render(<ComponentSection />)

    await user.click(await screen.findByTestId('instance-detach-button'))
    const refusal = await screen.findByTestId('instance-detach-refusal')
    expect(refusal.textContent).toContain('Card spreads its props')
    expect(screen.getByTestId('instance-extract-offer')).toBeTruthy()
  })

  it('offers no duplicate where a copy would refuse for the same reason', async () => {
    seedInstance()
    detachRefusal = { reason: 'unresolvable', message: 'Could not find where Card is declared.' }
    const user = userEvent.setup()
    render(<ComponentSection />)

    await user.click(await screen.findByTestId('instance-detach-button'))
    const refusal = await screen.findByTestId('instance-detach-refusal')
    expect(refusal.textContent).toContain('Could not find where Card is declared.')
    expect(screen.queryByTestId('instance-extract-offer')).toBeNull()
  })

  it('decides the duplicate offer through explainDetachConstraint, not a second copy of its list', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'ComponentSection.tsx'), 'utf8')
    expect(source).toContain('explainDetachConstraint')
    expect(source).not.toContain('EXTRACT_OFFER_REASONS')
  })
})
