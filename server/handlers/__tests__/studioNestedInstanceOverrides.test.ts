/**
 * G-2b — OD-19 for an element inside a component that is rendered by ANOTHER
 * component: editing it changes only the page's instance.
 *
 * A temp project (a booking checkout: pages render `Panel`, `Panel` renders
 * `Pill`) is written to disk and read back by the real board loader; the
 * planner is asked about the real `Pill` span three call sites deep from the
 * page; the edit it produces goes through the real `/save` batch engine; and
 * the files are parsed again to see what every `Panel` and every `Pill`
 * renders. The promise is asserted the way a user sees it: nothing but the
 * chosen instance moved, and one restore puts every file back byte for byte.
 *
 * It shares nothing with the eSIM corpus or the village-hall fixture of
 * `studioInstanceOverrides.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { callSitePosition, inlineDepth, type Page, type PageNode } from '@core/page-tree'
import { planInstanceOverride, type OverrideChange, type PlannedOverride } from '@site/store/slices/site/instanceOverridePlan'
import { snapshotNodeValues } from '@site/studio/loadedValuesBaseline'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

const PILL = [
  'interface PillProps { tone?: string }',
  'export function Pill({ tone }: PillProps) {',
  '  return <span title="Booking status" style={{ opacity: 0.9 }}>Open</span>',
  '}',
  '',
].join('\n')

const PANEL = [
  "import { Pill } from './Pill'",
  'export function Panel({ name }: { name: string }) {',
  '  return (',
  '    <section>',
  '      <h3>{name}</h3>',
  '      <Pill />',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')

const CHECKOUT = [
  "import { Panel } from '../components/Panel'",
  "import { Pill } from '../components/Pill'",
  'export default function Checkout() {',
  '  return (',
  '    <main>',
  '      <Panel name="Cart" />',
  '      <Panel name="Shipping" />',
  '      <Pill />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const PAY = [
  "import { Panel } from '../components/Panel'",
  'export default function Pay() {',
  '  return <Panel name="Pay" />',
  '}',
  '',
].join('\n')

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-nested-overrides-')))
  write('components/Pill.tsx', PILL)
  write('components/Panel.tsx', PANEL)
  write('pages/Checkout.tsx', CHECKOUT)
  write('pages/Pay.tsx', PAY)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Board {
  pages: Page[]
  /** The three `Panel` instances, in board order: Cart, Shipping, Pay. */
  panels: PageNode[]
  /** The `<Pill/>` placed directly on Checkout. */
  loosePill: PageNode
}

async function board(): Promise<Board> {
  const { pages } = await loadStudioPages(dir)
  const order = ['Cart', 'Shipping', 'Pay']
  const nameOf = (node: PageNode) => (node.props as { callSiteProps: { name: string } }).callSiteProps.name
  const instances = pages.flatMap((page) => Object.values(page.nodes)).filter((node) => node.moduleId === 'studio.instance')
  const panels = instances.filter((node) => (node.props as { componentName?: string }).componentName === 'Panel').sort((a, b) => order.indexOf(nameOf(a)) - order.indexOf(nameOf(b)))
  const loosePill = instances.find((node) => (node.props as { componentName?: string }).componentName === 'Pill' && inlineDepth(node.id) === 0)!
  return { pages, panels, loosePill }
}

/** The page-tree node of the `<span>` (Pill's element) inside `root`'s subtree, wherever it is. */
function spanOf(b: Board, root: PageNode): PageNode {
  const page = b.pages.find((candidate) => candidate.nodes[root.id])!
  const found = Object.values(page.nodes).find((node) => node.id.startsWith(`${root.id}~`) && node.fromComponent === 'Pill' && inlineDepth(node.id) >= 1 && node.id.endsWith('Pill.tsx:3:11'))
  if (!found) throw new Error(`no Pill span under ${root.id}`)
  return found
}

const spanText = (node: PageNode): string => (node.props as { text: string }).text

/** What a board renders for every Pill span: the text, the title and the opacity. */
function renderedSpans(b: Board): { text: string; title: string | undefined; opacity: unknown }[] {
  return b.pages
    .flatMap((page) => Object.values(page.nodes))
    .filter((node) => node.fromComponent === 'Pill' && node.id.endsWith('Pill.tsx:3:11'))
    .sort((a, b2) => a.id.localeCompare(b2.id))
    .map((node) => ({ text: spanText(node), title: (node.props as { title?: string }).title, opacity: node.inlineStyles?.opacity }))
}

function planFor(b: Board, element: PageNode, change: OverrideChange) {
  const page = b.pages.find((candidate) => candidate.nodes[element.id])
  return planInstanceOverride({
    node: element,
    nodeId: element.id,
    change,
    textProp: 'text',
    baseline: snapshotNodeValues(b.pages).get(element.id),
    callSite: page?.nodes[callSitePosition(element.id)],
  })
}

const exposeEdit = (element: PageNode, overrides: PlannedOverride[]): StudioEdit => ({
  kind: 'expose-prop',
  nodeId: element.id,
  overrides: overrides.map(({ target, propName, value }) => ({ target, propName, value })),
})

async function override(b: Board, element: PageNode, change: OverrideChange) {
  const plan = planFor(b, element, change)
  if (plan.kind !== 'override') throw new Error(`expected an override plan, got ${JSON.stringify(plan)}`)
  return { plan, result: applyStudioEditBatch(dir, [exposeEdit(element, plan.overrides)], {}, EDITOR) }
}

describe('a value inside a component rendered by another component changes only the page instance', () => {
  it('text two call sites deep: the value is passed down Panel to Pill, and every other Panel and Pill renders what it did', async () => {
    const before = await board()
    const cartSpan = spanOf(before, before.panels[0]!)
    expect(inlineDepth(cartSpan.id)).toBe(2)
    const rendered = renderedSpans(before)

    const { plan, result } = await override(before, cartSpan, { props: { text: 'Closed' } })
    expect(plan.overrides).toEqual([{ key: 'text', target: { kind: 'text' }, propName: 'label', value: 'Closed' }])
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)

    // Three files, one gesture: the page passes the value, Panel passes it on, Pill takes it with the old text as its default.
    expect(read('pages/Checkout.tsx')).toContain('<Panel name="Cart" label="Closed" />')
    expect(read('pages/Checkout.tsx')).toContain('<Panel name="Shipping" />')
    expect(read('components/Panel.tsx')).toContain("{ name, label = 'Open' }: { name: string; label?: string }")
    expect(read('components/Panel.tsx')).toContain('<Pill label={label} />')
    expect(read('components/Pill.tsx')).toContain("{ tone, label = 'Open' }: PillProps")
    expect(read('components/Pill.tsx')).toContain('>{label}</span>')
    expect(read('components/Pill.tsx')).toContain('label?: string')
    expect(read('pages/Pay.tsx')).toBe(PAY)

    const after = await board()
    expect(renderedSpans(after).map((span) => span.text).sort()).toEqual(['Closed', 'Open', 'Open', 'Open'])
    // The ones that did not change are the same, field for field: Shipping, Pay, and the Pill on the page.
    expect(renderedSpans(after).slice(1)).toEqual(rendered.slice(1))
    // The chosen instance owns the text at its own call site now.
    expect(spanOf(after, after.panels[0]!).textOrigin?.rel).toBe('pages/Checkout.tsx')

    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/Pill.tsx')).toBe(PILL)
    expect(read('components/Panel.tsx')).toBe(PANEL)
    expect(read('pages/Checkout.tsx')).toBe(CHECKOUT)
  })

  it('an attribute and a style value go the same way, and a gesture with both is one write', async () => {
    const before = await board()
    const paySpan = spanOf(before, before.panels[2]!)
    const { plan, result } = await override(before, paySpan, { props: { title: 'Payment status' }, styles: { opacity: 0.4 } })
    expect(plan.overrides.map((entry) => entry.propName)).toEqual(['titleText', 'opacityValue'])
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Pay.tsx')).toContain('<Panel name="Pay" titleText="Payment status" opacityValue={0.4} />')
    expect(read('components/Panel.tsx')).toContain('<Pill titleText={titleText} opacityValue={opacityValue} />')
    const after = await board()
    const spans = renderedSpans(after)
    expect(spans.filter((span) => span.title === 'Payment status')).toHaveLength(1)
    expect(spans.filter((span) => span.opacity === 0.9)).toHaveLength(3)
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/Panel.tsx')).toBe(PANEL)
    expect(read('components/Pill.tsx')).toBe(PILL)
    expect(read('pages/Pay.tsx')).toBe(PAY)
  })

  it('after one nested override, the other instances stay editable per instance: the page call site gains the attribute and nothing else changes', async () => {
    const first = await board()
    await override(first, spanOf(first, first.panels[0]!), { props: { text: 'Closed' } })
    const after = await board()
    const panelsCode = { panel: read('components/Panel.tsx'), pill: read('components/Pill.tsx') }
    const shipping = spanOf(after, after.panels[1]!)
    // The page-level prop that feeds it, through Panel and Pill.
    expect(shipping.propFeeds).toEqual({ text: 'label' })
    expect(shipping.codeProps ?? []).not.toContain('text')

    const { plan, result } = await override(after, shipping, { props: { text: 'Paused' } })
    expect(plan.overrides).toEqual([{ key: 'text', target: { kind: 'text' }, propName: 'label', value: 'Paused', fed: true }])
    expect(result.refusals).toEqual([])
    expect(read('pages/Checkout.tsx')).toContain('<Panel name="Shipping" label="Paused" />')
    expect(read('components/Panel.tsx')).toBe(panelsCode.panel)
    expect(read('components/Pill.tsx')).toBe(panelsCode.pill)
    const final = await board()
    expect(renderedSpans(final).map((span) => span.text).sort()).toEqual(['Closed', 'Open', 'Open', 'Paused'])
  })

  it('Apply to all after a nested override makes the value the default of the page\'s component, for every Panel', async () => {
    const first = await board()
    await override(first, spanOf(first, first.panels[0]!), { props: { text: 'Closed' } })
    const mid = await board()
    const cart = mid.panels[0]!
    const promoted = applyStudioEditBatch(dir, [{ kind: 'promote-override', nodeId: cart.children[0]!, propNames: ['label'] }], {}, EDITOR)
    expect(promoted.refusals).toEqual([])
    expect(read('components/Panel.tsx')).toContain("label = 'Closed'")
    expect(read('pages/Checkout.tsx')).toBe(CHECKOUT)
    const final = await board()
    // Every Panel shows it; the Pill placed directly on the page is another use of Pill and keeps its own default.
    expect(renderedSpans(final).map((span) => span.text).sort()).toEqual(['Closed', 'Closed', 'Closed', 'Open'])
  })
})

describe('what stays as it was, with the reason, or refuses by name', () => {
  it('a Panel that spreads props refuses the threading, and no file changes', async () => {
    write('pages/Pay.tsx', "import { Panel } from '../components/Panel'\nexport default function Pay(props) {\n  return <Panel name=\"Pay\" {...props} />\n}\n")
    const before = await board()
    const span = spanOf(before, before.panels[2]!)
    const plan = planFor(before, span, { props: { text: 'Closed' } })
    if (plan.kind !== 'override') throw new Error('the server is the one to refuse a spread')
    const files = { panel: read('components/Panel.tsx'), pill: read('components/Pill.tsx'), pay: read('pages/Pay.tsx'), checkout: read('pages/Checkout.tsx') }
    const result = applyStudioEditBatch(dir, [exposeEdit(span, plan.overrides)], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['call-site-spread'])
    expect(read('components/Panel.tsx')).toBe(files.panel)
    expect(read('components/Pill.tsx')).toBe(files.pill)
    expect(read('pages/Pay.tsx')).toBe(files.pay)
    expect(read('pages/Checkout.tsx')).toBe(files.checkout)
  })

  it('a Panel that renders Pill inside a list is the ordinary edit with its sentence: one piece of code renders every item', async () => {
    write('components/Panel.tsx', PANEL.replace('<Pill />', '{[1, 2].map((n) => <Pill key={n} />)}'))
    const before = await board()
    const rowSpan = Object.values(before.pages.flatMap((page) => Object.values(page.nodes))).find((node) => node.fromComponent === 'Pill' && node.id.includes('#'))
    expect(rowSpan).toBeDefined()
    const plan = planFor(before, rowSpan!, { props: { text: 'Closed' } })
    expect(plan.kind).not.toBe('override')
  })

  it('a value a middle component gives itself is shared by every Panel: no feed, so the edit is the ordinary refusal by name', async () => {
    write('components/Panel.tsx', PANEL.replace('<Pill />', '<Pill label="Always" />'))
    write('components/Pill.tsx', PILL.replace('{ tone }: PillProps', "{ tone, label = 'Open' }: PillProps & { label?: string }").replace('>Open</span>', '>{label}</span>'))
    const before = await board()
    const span = Object.values(before.pages.flatMap((page) => Object.values(page.nodes))).find((node) => node.fromComponent === 'Pill' && inlineDepth(node.id) === 2)!
    expect(span.propFeeds).toBeUndefined()
  })
})
