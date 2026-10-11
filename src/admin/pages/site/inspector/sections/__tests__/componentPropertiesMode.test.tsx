/**
 * The Component section's "Main component" mode (CV-3): the component's own
 * variants and properties, with "+" to add a variant or a property and a
 * remove button per value. Proven against the real section, a mocked catalog
 * and a mocked `/save` that records what the editor POSTS — the contract with
 * the server (`add-variant` / `remove-variant` / `add-component-prop`, addressed
 * by the component's `file:line:col` and export name, nothing else).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComponentSection } from '../ComponentSection'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'

const originalFetch = globalThis.fetch

const INSTANCE_ID = 'src/pages/Home.tsx:5:3'
/** A gallery cell's call site: a loop-style id, so it has no source location of its own. */
const GALLERY_CELL_ID = 'src/components/Card.tsx:4:17#2'

/** Every `/save` body the editor posted, parsed. */
let saved: Array<{ edits: Array<Record<string, unknown>> }> = []
/** The catalog the mocked `/components` answers with. */
let catalogProps: unknown[] = []

const VARIANT_BINDING = {
  kind: 'css-module-class',
  scope: 'module',
  expr: 'styles[variant]',
  classPrefix: '',
  classSuffix: '',
  range: { file: 'src/components/Card.tsx', line: 8, column: 24, endLine: 8, endColumn: 39 },
  rules: [
    { member: 'primary', selector: '.primary', range: { file: 'src/components/Card.module.css', line: 1, column: 1, endLine: 3, endColumn: 2 } },
    { member: 'ghost', selector: '.ghost', range: { file: 'src/components/Card.module.css', line: 5, column: 1, endLine: 7, endColumn: 2 } },
  ],
}

const CARD_PROPS = [
  { name: 'title', kind: { kind: 'string' }, required: true },
  { name: 'variant', kind: { kind: 'enum', values: ['primary', 'ghost'] }, required: false, defaultValue: 'primary', binding: VARIANT_BINDING },
  { name: 'pinned', kind: { kind: 'boolean' }, required: false, defaultValue: true },
]

function seedInstance(nodeId = INSTANCE_ID) {
  const owner = makeNode({
    id: nodeId,
    moduleId: 'studio.instance',
    props: { componentName: 'Card', source: 'local', sourceFile: 'src/components/Card.tsx', callSiteProps: { title: 'Hello' } },
  })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [owner.id] })
  const page = makePage({ id: 'page-1', nodes: { root, [owner.id]: owner } })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: owner.id,
    selectedNodeIds: [owner.id],
    _nodeIdToPageIds: new Map([
      [owner.id, [page.id]],
      [root.id, [page.id]],
    ]),
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _nodeIdToPageIds: new Map(),
    structuralRefusalDialog: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  __resetToastBusForTests()
  resetStructuralCommitQueue()
  invalidateLocalComponentCatalog()
  saved = []
  catalogProps = CARD_PROPS
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/admin/api/studio/save')) {
      saved.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false, refusals: [] }), { status: 200 })
    }
    if (url.includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({
          components: [
            { name: 'Card', file: 'src/components/Card.tsx', exportName: 'Card', isDefaultExport: false, line: 4, column: 17, role: 'component', props: catalogProps },
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

async function openMainComponentMode() {
  const user = userEvent.setup()
  render(<ComponentSection />)
  const mode = await screen.findByTestId('component-mode')
  await user.click(within(mode).getByRole('button', { name: 'Main component' }))
  await screen.findByTestId('component-properties-editor')
  return user
}

describe('ComponentSection — Main component mode', () => {
  it('starts on the instance, offers the main component, and lists the variant values with the default marked', async () => {
    seedInstance()
    await openMainComponentMode()

    const axis = screen.getByTestId('component-property-variant')
    expect(within(axis).getByTestId('variant-value-variant-primary').textContent).toContain('default')
    expect(within(axis).getByTestId('variant-value-variant-ghost')).toBeTruthy()
    expect(screen.getByTestId('component-property-pinned').textContent).toContain('on/off')
    // The scope is stated once: this edits the definition, not one instance.
    expect(screen.getByTestId('component-properties-editor').textContent).toContain('every instance changes')
  })

  it('opens a generated gallery cell on the main component, which has no call site to edit', async () => {
    seedInstance(GALLERY_CELL_ID)
    render(<ComponentSection />)
    expect(await screen.findByTestId('component-properties-editor')).toBeTruthy()
  })

  it('Add variant posts one add-variant edit addressed by the component, after validating the name', async () => {
    seedInstance()
    const user = await openMainComponentMode()

    await user.click(screen.getByTestId('add-variant-button-variant'))
    const form = await screen.findByTestId('add-variant-form')
    expect(form.textContent).toContain('Starts as a copy of "primary"')
    const submit = within(form).getByTestId('add-variant-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    await user.type(within(form).getByTestId('add-variant-name'), 'ghost')
    expect(within(form).getByRole('alert').textContent).toContain('already exists')
    expect(submit.disabled).toBe(true)

    await user.clear(within(form).getByTestId('add-variant-name'))
    await user.type(within(form).getByTestId('add-variant-name'), 'danger')
    expect(submit.disabled).toBe(false)
    await user.click(submit)

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]!.edits).toEqual([
      { kind: 'add-variant', nodeId: 'src/components/Card.tsx:4:17', exportName: 'Card', prop: 'variant', name: 'danger' },
    ])
  })

  it('Remove posts remove-variant; the default value cannot be removed', async () => {
    seedInstance()
    const user = await openMainComponentMode()

    // A disabled button with a tooltip is `aria-disabled`, not natively disabled (so the tooltip still shows).
    expect(screen.getByTestId('remove-variant-variant-primary').getAttribute('aria-disabled')).toBe('true')
    await user.click(screen.getByTestId('remove-variant-variant-primary'))
    expect(saved).toEqual([])
    await user.click(screen.getByTestId('remove-variant-variant-ghost'))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]!.edits).toEqual([
      { kind: 'remove-variant', nodeId: 'src/components/Card.tsx:4:17', exportName: 'Card', prop: 'variant', name: 'ghost' },
    ])
  })

  it('Add property posts add-component-prop with the type and default', async () => {
    seedInstance()
    const user = await openMainComponentMode()

    await user.click(screen.getByTestId('add-property-button'))
    const form = await screen.findByTestId('add-property-form')
    await user.type(within(form).getByTestId('add-property-name'), 'size')
    await user.click(within(within(form).getByTestId('add-property-type')).getByRole('button', { name: 'Variant' }))
    await user.type(within(form).getByTestId('add-property-values'), 'sm')
    expect((within(form).getByTestId('add-property-submit') as HTMLButtonElement).disabled).toBe(true)
    await user.type(within(form).getByTestId('add-property-values'), ', md, lg')
    await user.click(within(form).getByTestId('add-property-submit'))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]!.edits).toEqual([
      {
        kind: 'add-component-prop',
        nodeId: 'src/components/Card.tsx:4:17',
        exportName: 'Card',
        name: 'size',
        propType: { kind: 'variant', members: ['sm', 'md', 'lg'] },
      },
    ])
  })

  it('refuses a property name the component already takes, before any request', async () => {
    seedInstance()
    const user = await openMainComponentMode()

    await user.click(screen.getByTestId('add-property-button'))
    const form = await screen.findByTestId('add-property-form')
    await user.type(within(form).getByTestId('add-property-name'), 'title')
    expect(within(form).getByRole('alert').textContent).toContain('already exists')
    expect((within(form).getByTestId('add-property-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(saved).toEqual([])
  })

  it('says why Add variant is unavailable for a prop styled in computed code, and offers to open it', async () => {
    catalogProps = [
      {
        name: 'tone',
        kind: { kind: 'enum', values: ['calm', 'loud'] },
        required: false,
        defaultValue: 'calm',
        binding: { kind: 'opaque', file: 'src/components/Card.tsx', line: 41, reason: '`tone` is used in computed code at line 41' },
      },
    ]
    seedInstance()
    const user = await openMainComponentMode()

    await user.click(screen.getByTestId('add-variant-button-tone'))
    const blocked = await screen.findByTestId('add-variant-blocked')
    expect(blocked.textContent).toContain('computed code')
    expect(screen.queryByTestId('add-variant-name')).toBeNull()
    expect(within(blocked).getByTestId('add-variant-open-code')).toBeTruthy()
    expect(saved).toEqual([])
  })
})
