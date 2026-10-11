/**
 * The way from a selected INSTANCE to editing a variant's style (CV-4): the
 * Component section's "Main component" mode says which rule a style edit goes
 * to, and one press opens the instance on the element that carries the variant.
 * A variant with no honest rule is a refusal there, with its remedy, and no button.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComponentSection } from '../ComponentSection'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'

const originalFetch = globalThis.fetch

const INSTANCE_ID = 'src/pages/Home.tsx:5:3'
const ROOT_EL = `${INSTANCE_ID}~src/components/Pill.tsx:6:10`

const RANGE = { file: 'src/components/Pill.css', line: 1, column: 1, endLine: 3, endColumn: 2 }
const CLASS_BINDING = {
  kind: 'css-module-class',
  scope: 'global',
  expr: '`pill pill-${tone}`',
  classPrefix: 'pill-',
  classSuffix: '',
  element: { line: 6, column: 10 },
  range: { file: 'src/components/Pill.tsx', line: 6, column: 30, endLine: 6, endColumn: 50 },
  rules: [
    { member: 'calm', selector: '.pill-calm', range: RANGE },
    { member: 'loud', selector: '.pill-loud', range: { ...RANGE, line: 5 } },
  ],
}
const OPAQUE_BINDING = {
  kind: 'opaque',
  file: 'src/components/Pill.tsx',
  line: 4,
  element: { line: 6, column: 10 },
  reason: '`tone` is used in computed code at line 4',
}

let binding: unknown = CLASS_BINDING

function seed(callSiteProps: Record<string, unknown> = { tone: 'loud' }) {
  const instance = makeNode({
    id: INSTANCE_ID,
    moduleId: 'studio.instance',
    children: [ROOT_EL],
    props: { componentName: 'Pill', source: 'local', sourceFile: 'src/components/Pill.tsx', callSiteProps },
  })
  const root = makeNode({ id: ROOT_EL, moduleId: 'base.span', fromComponent: 'Pill' })
  const body = makeNode({ id: 'page-1:body', moduleId: 'base.body', children: [INSTANCE_ID] })
  const page = makePage({ id: 'page-1', rootNodeId: body.id, nodes: { [body.id]: body, [instance.id]: instance, [root.id]: root } })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: instance.id,
    selectedNodeIds: [instance.id],
    enteredInstanceIds: [],
    mainEditComponent: null,
    variantEditAxis: null,
    _nodeIdToPageIds: new Map([
      [body.id, [page.id]],
      [instance.id, [page.id]],
      [root.id, [page.id]],
    ]),
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  binding = CLASS_BINDING
  invalidateLocalComponentCatalog()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({
          components: [
            {
              name: 'Pill',
              file: 'src/components/Pill.tsx',
              exportName: 'Pill',
              isDefaultExport: false,
              line: 3,
              column: 17,
              role: 'component',
              props: [
                { name: 'text', kind: { kind: 'string' }, required: true },
                { name: 'tone', kind: { kind: 'enum', values: ['calm', 'loud'] }, required: false, defaultValue: 'calm', binding },
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

async function openMainComponentMode() {
  const user = userEvent.setup()
  render(<ComponentSection />)
  const mode = await screen.findByTestId('component-mode')
  await user.click(within(mode).getByRole('button', { name: 'Main component' }))
  return user
}

describe('ComponentSection — the style entry in Main component mode', () => {
  it('names the rule an edit goes to for the call site\'s value, and Edit style opens the instance on the variant\'s element', async () => {
    seed({ tone: 'loud' })
    const user = await openMainComponentMode()

    expect((await screen.findByTestId('variant-style-entry-text')).textContent).toBe('Style edits go to .pill-loud in Pill.css.')
    await user.click(screen.getByTestId('variant-style-entry-edit'))

    const state = useEditorStore.getState()
    expect(state.mainEditComponent).toBe('Pill')
    expect(state.enteredInstanceIds).toEqual([INSTANCE_ID])
    expect(state.selectedNodeId).toBe(ROOT_EL)
  })

  it('an unset prop is the declared default', async () => {
    seed({})
    await openMainComponentMode()
    expect((await screen.findByTestId('variant-style-entry-text')).textContent).toBe('Style edits go to .pill-calm in Pill.css.')
  })

  it('a variant with no honest rule is a refusal naming the line and the remedy, with no way to edit', async () => {
    binding = OPAQUE_BINDING
    seed({ tone: 'loud' })
    await openMainComponentMode()

    const refusal = await screen.findByTestId('variant-style-entry-refusal')
    expect(refusal.textContent).toContain('tone loud')
    expect(refusal.textContent).toContain('src/components/Pill.tsx:4')
    expect(refusal.textContent).toContain('Open src/components/Pill.tsx:4')
    expect(screen.queryByTestId('variant-style-entry-edit')).toBeNull()
    expect(screen.getByTestId('variant-style-entry-open-code')).toBeTruthy()
  })

  it('renders nothing when no variant prop styles an element of the component', async () => {
    seed({ tone: 'loud' })
    // The element the binding names is not in the instance's expanded tree.
    const page = useEditorStore.getState().site!.pages[0]!
    const nodes = { ...page.nodes }
    delete nodes[ROOT_EL]
    nodes[INSTANCE_ID] = { ...nodes[INSTANCE_ID]!, children: [] }
    useEditorStore.setState({ site: makeSite({ pages: [{ ...page, nodes }] }) } as Parameters<typeof useEditorStore.setState>[0])
    await openMainComponentMode()
    await screen.findByTestId('component-properties-editor')
    expect(screen.queryByTestId('variant-style-entry')).toBeNull()
  })
})
