/**
 * OD-19 on a REAL project: editing a value inside a shared component changes
 * ONLY that instance.
 *
 * Nothing here is a hand-built tree. A temp project is written to disk and read
 * back by the real board loader (`loadStudioPages`); the planner
 * (`planInstanceOverride`) is asked about a real node and a real baseline; the
 * edit it produces goes through the real `/save` batch engine
 * (`applyStudioEditBatch`, journaled like the editor's); and the files are
 * parsed AGAIN to see what every instance renders. The default-preservation
 * promise is asserted the way a user would see it: the other instances' text,
 * attributes and styles, before and after.
 *
 * The project (a village-hall booking app) shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { callSitePosition, type Page, type PageNode } from '@core/page-tree'
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

const ROOM_CARD = [
  'interface RoomCardProps { name: string }',
  'export function RoomCard({ name }: RoomCardProps) {',
  '  return (',
  '    <article>',
  '      <h3>Main hall</h3>',
  '      <img src="/hall.png" alt="Hall photo" />',
  '      <p style={{ opacity: 0.8, color: "slategray" }}>{name}</p>',
  '    </article>',
  '  )',
  '}',
  '',
].join('\n')

const ROOMS = [
  "import { RoomCard } from '../components/RoomCard'",
  'export default function Rooms() {',
  '  return (',
  '    <main>',
  '      <RoomCard name="Oak room" />',
  '      <RoomCard name="Elm room" />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const HIRE = [
  "import { RoomCard } from '../components/RoomCard'",
  'export default function Hire() {',
  '  return <RoomCard name="Birch room" />',
  '}',
  '',
].join('\n')

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-instance-overrides-')))
  write('components/RoomCard.tsx', ROOM_CARD)
  write('pages/Rooms.tsx', ROOMS)
  write('pages/Hire.tsx', HIRE)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Board {
  pages: Page[]
  /** Every `RoomCard` instance, in board order. */
  instances: PageNode[]
}

async function board(): Promise<Board> {
  const { pages } = await loadStudioPages(dir)
  const order = ['Oak room', 'Elm room', 'Birch room']
  const nameOf = (node: PageNode) => (node.props as { callSiteProps: { name: string } }).callSiteProps.name
  const instances = pages
    .flatMap((page) => Object.values(page.nodes))
    .filter((node) => node.moduleId === 'studio.instance' && (node.props as { componentName?: string }).componentName === 'RoomCard')
    .sort((a, b) => order.indexOf(nameOf(a)) - order.indexOf(nameOf(b)))
  return { pages, instances }
}

/** `RoomCard.tsx`'s elements by the line they sit on: the `<h3>`, the `<img>` and the `<p>`. */
const ELEMENT_LINES = { h3: 5, img: 6, p: 7 } as const

/** The page-tree node of the element `tag` inside `instance` (one call site deep). */
function elementOf(b: Board, instance: PageNode, tag: keyof typeof ELEMENT_LINES): PageNode {
  const page = b.pages.find((candidate) => candidate.nodes[instance.id])!
  const found = Object.values(page.nodes).find((node) => node.id.startsWith(`${instance.id}~`) && node.id.endsWith(`RoomCard.tsx:${ELEMENT_LINES[tag]}:8`))
  if (!found) throw new Error(`no <${tag}> inside ${instance.id}`)
  return found
}

/** What an instance RENDERS for its inner elements, ignoring how the source spells it. */
function rendered(b: Board, instance: PageNode): unknown[] {
  const page = b.pages.find((candidate) => candidate.nodes[instance.id])!
  return Object.values(page.nodes)
    .filter((node) => node.id.startsWith(`${instance.id}~`))
    .map((node) => ({ module: node.moduleId, text: (node.props as { text?: string }).text, alt: (node.props as { alt?: string }).alt, style: node.inlineStyles }))
}

/** The `expose-prop` edit the editor posts for `change` made to `element`, or the plan if it is not an override. */
function planFor(b: Board, element: PageNode, change: OverrideChange) {
  const baseline = snapshotNodeValues(b.pages).get(element.id)
  const page = b.pages.find((candidate) => candidate.nodes[element.id])
  return planInstanceOverride({ node: element, nodeId: element.id, change, textProp: 'text', baseline, callSite: page?.nodes[callSitePosition(element.id)] })
}

function exposeEdit(element: PageNode, overrides: PlannedOverride[]): StudioEdit {
  return { kind: 'expose-prop', nodeId: element.id, overrides: overrides.map(({ target, propName, value }) => ({ target, propName, value })) }
}

async function override(b: Board, element: PageNode, change: OverrideChange) {
  const plan = planFor(b, element, change)
  if (plan.kind !== 'override') throw new Error(`expected an override plan, got ${JSON.stringify(plan)}`)
  const result = applyStudioEditBatch(dir, [exposeEdit(element, plan.overrides)], {}, EDITOR)
  return { plan, result }
}

describe('a value edited inside a shared component changes only that instance', () => {
  it('text: this instance shows the new text, every other instance renders exactly what it did, and one restore puts both files back', async () => {
    const before = await board()
    const [first, second, third] = before.instances
    expect(before.instances).toHaveLength(3)
    const othersBefore = [rendered(before, second!), rendered(before, third!)]

    const heading = elementOf(before, first!, 'h3')
    const { plan, result } = await override(before, heading, { props: { text: 'Committee room' } })
    expect(plan.overrides).toEqual([{ key: 'text', target: { kind: 'text' }, propName: 'heading', value: 'Committee room' }])
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)

    // Two files changed, in the way the codemod promises.
    expect(read('components/RoomCard.tsx')).toContain("{ name, heading = 'Main hall' }: RoomCardProps")
    expect(read('components/RoomCard.tsx')).toContain('<h3>{heading}</h3>')
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Oak room" heading="Committee room" />')
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" />')

    const after = await board()
    const heads = after.instances.map((instance) => (elementOf(after, instance, 'h3').props as { text: string }).text)
    expect(heads).toEqual(['Committee room', 'Main hall', 'Main hall'])
    // Default preservation: not one rendered value of another instance moved.
    expect([rendered(after, after.instances[1]!), rendered(after, after.instances[2]!)]).toEqual(othersBefore)
    // The instance now owns its text at its own call site, so a second edit is an ordinary, instance-local literal write.
    expect(elementOf(after, after.instances[0]!, 'h3').textOrigin?.rel).toBe('pages/Rooms.tsx')

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toBe(ROOM_CARD)
    expect(read('pages/Rooms.tsx')).toBe(ROOMS)
  })

  it('attribute: alt becomes a prop whose default is the old alt', async () => {
    const before = await board()
    const picture = elementOf(before, before.instances[1]!, 'img')
    const othersBefore = [rendered(before, before.instances[0]!), rendered(before, before.instances[2]!)]
    const { plan, result } = await override(before, picture, { props: { alt: 'Elm room, east wall' } })
    expect(plan.overrides[0]).toMatchObject({ key: 'alt', target: { kind: 'attribute', name: 'alt' }, propName: 'altText' })
    expect(result.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toContain("altText = 'Hall photo'")
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" altText="Elm room, east wall" />')

    const after = await board()
    expect(after.instances.map((instance) => (elementOf(after, instance, 'img').props as { alt: string }).alt)).toEqual(['Hall photo', 'Elm room, east wall', 'Hall photo'])
    expect([rendered(after, after.instances[0]!), rendered(after, after.instances[2]!)]).toEqual(othersBefore)
  })

  it('inline style: opacity becomes a prop; the other instances keep 0.8, and a number stays a number', async () => {
    const before = await board()
    const caption = elementOf(before, before.instances[2]!, 'p')
    const othersBefore = [rendered(before, before.instances[0]!), rendered(before, before.instances[1]!)]
    const { plan, result } = await override(before, caption, { styles: { opacity: 0.3 } })
    expect(plan.overrides[0]).toMatchObject({ key: 'style:opacity', target: { kind: 'style', property: 'opacity' }, propName: 'opacityValue', value: 0.3 })
    expect(result.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toContain('opacityValue = 0.8')
    expect(read('components/RoomCard.tsx')).toContain('opacityValue?: number')
    expect(read('pages/Hire.tsx')).toContain('<RoomCard name="Birch room" opacityValue={0.3} />')

    const after = await board()
    expect(after.instances.map((instance) => (elementOf(after, instance, 'p').inlineStyles as { opacity: number }).opacity)).toEqual([0.8, 0.8, 0.3])
    expect([rendered(after, after.instances[0]!), rendered(after, after.instances[1]!)]).toEqual(othersBefore)
  })

  it('one gesture with several values is one write and one undo', async () => {
    const before = await board()
    const heading = elementOf(before, before.instances[0]!, 'h3')
    const plan = planFor(before, heading, { props: { text: 'Hall', title: 'x' } })
    // `title` is not an attribute of this heading: the whole gesture is the ordinary write, with its sentence.
    expect(plan.kind).toBe('whole-component')

    const caption = elementOf(before, before.instances[0]!, 'p')
    const multi = planFor(before, caption, { styles: { opacity: 0.5, color: 'tomato' } })
    if (multi.kind !== 'override') throw new Error('expected an override')
    const result = applyStudioEditBatch(dir, [exposeEdit(caption, multi.overrides)], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Oak room" opacityValue={0.5} colorValue="tomato" />')
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toBe(ROOM_CARD)
    expect(read('pages/Rooms.tsx')).toBe(ROOMS)
  })
})

describe('Apply to all', () => {
  it('writes the override into the component, drops it from the call site, and every instance that did not override it shows it', async () => {
    const before = await board()
    const heading = elementOf(before, before.instances[0]!, 'h3')
    const { result: exposed } = await override(before, heading, { props: { text: 'Committee room' } })
    const exposedFiles = { card: read('components/RoomCard.tsx'), rooms: read('pages/Rooms.tsx') }

    // What the toast does: the instance's props that were not there before, addressed through any element of that instance.
    const mid = await board()
    const instance = mid.instances[0]!
    const callSiteProps = (instance.props as { callSiteProps: Record<string, unknown> }).callSiteProps
    const propNames = Object.keys(callSiteProps).filter((key) => !(key in (before.instances[0]!.props as { callSiteProps: Record<string, unknown> }).callSiteProps))
    expect(propNames).toEqual(['heading'])
    const anyElement = instance.children[0]!
    const promoted = applyStudioEditBatch(dir, [{ kind: 'promote-override', nodeId: anyElement, propNames }], {}, EDITOR)
    expect(promoted.refusals).toEqual([])
    expect(promoted.written).toBe(1)
    expect(read('components/RoomCard.tsx')).toContain("heading = 'Committee room'")
    expect(read('pages/Rooms.tsx')).toBe(ROOMS)

    const after = await board()
    expect(after.instances.map((node) => (elementOf(after, node, 'h3').props as { text: string }).text)).toEqual(['Committee room', 'Committee room', 'Committee room'])

    // ⌘Z on Apply to all returns to the override, byte for byte; ⌘Z again returns to the start.
    expect(applyStudioEditBatch(dir, [restore(promoted.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toBe(exposedFiles.card)
    expect(read('pages/Rooms.tsx')).toBe(exposedFiles.rooms)
    expect(applyStudioEditBatch(dir, [restore(exposed.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toBe(ROOM_CARD)
    expect(read('pages/Rooms.tsx')).toBe(ROOMS)
  })

  it('refuses, writing nothing, when the component no longer has a plain default for the prop', async () => {
    const before = await board()
    await override(before, elementOf(before, before.instances[0]!, 'h3'), { props: { text: 'Committee room' } })
    write('components/RoomCard.tsx', read('components/RoomCard.tsx').replace("heading = 'Main hall'", 'heading = fallbackHeading()'))
    const mid = await board()
    const card = read('components/RoomCard.tsx')
    const rooms = read('pages/Rooms.tsx')
    const result = applyStudioEditBatch(dir, [{ kind: 'promote-override', nodeId: mid.instances[0]!.children[0]!, propNames: ['heading'] }], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['no-default'])
    expect(read('components/RoomCard.tsx')).toBe(card)
    expect(read('pages/Rooms.tsx')).toBe(rooms)
  })
})

describe('what stays as it was, with the reason', () => {
  it('a style the markup does not state is the ordinary write: the plan says so in one sentence', async () => {
    const before = await board()
    const plan = planFor(before, elementOf(before, before.instances[0]!, 'p'), { styles: { margin: '4px' } })
    expect(plan).toEqual({ kind: 'whole-component', reason: 'RoomCard does not set `margin` on that element, so this changes every RoomCard.' })
  })

  it('a call site that spreads props refuses the override by name, and nothing is written', async () => {
    write('pages/Hire.tsx', "import { RoomCard } from '../components/RoomCard'\nexport default function Hire(props) {\n  return <RoomCard name=\"Birch room\" {...props} />\n}\n")
    const before = await board()
    const heading = elementOf(before, before.instances[0]!, 'h3')
    const plan = planFor(before, heading, { props: { text: 'Committee room' } })
    if (plan.kind !== 'override') throw new Error('the plan is the server\'s to refuse, not the client\'s')
    const result = applyStudioEditBatch(dir, [exposeEdit(heading, plan.overrides)], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['call-site-spread'])
    expect(read('components/RoomCard.tsx')).toBe(ROOM_CARD)
    expect(read('pages/Rooms.tsx')).toBe(ROOMS)
  })

  it('an element two components deep, or in a list row, cannot carry a per-instance value', async () => {
    const nested = 'pages/Rooms.tsx:5:8~components/RoomCard.tsx:5:8~components/Badge.tsx:2:10'
    const node = { id: nested, moduleId: 'base.text', props: { text: 'New', tag: 'span' }, fromComponent: 'Badge' } as unknown as PageNode
    const plan = planInstanceOverride({ node, nodeId: nested, change: { props: { text: 'Newer' } }, textProp: 'text', baseline: { text: 'New', tag: 'span' }, callSite: undefined })
    expect(plan.kind).toBe('whole-component')
    const row = 'pages/Rooms.tsx:5:8#2~components/RoomCard.tsx:5:8'
    const rowPlan = planInstanceOverride({ node: { ...node, id: row } as PageNode, nodeId: row, change: { props: { text: 'Newer' } }, textProp: 'text', baseline: { text: 'New', tag: 'span' }, callSite: undefined })
    expect(rowPlan).toEqual({ kind: 'whole-component', reason: 'Badge is repeated by a list here, and one piece of code renders every item, so this changes every Badge.' })
  })
})

describe('after one override, every other instance stays editable per instance', () => {
  /** Overrides instance 0's heading and returns the board after, with the files as they then stood. */
  async function afterFirstOverride() {
    const before = await board()
    const { result } = await override(before, elementOf(before, before.instances[0]!, 'h3'), { props: { text: 'Committee room' } })
    return { after: await board(), card: read('components/RoomCard.tsx'), rooms: read('pages/Rooms.tsx'), firstUndo: result.undoToken! }
  }

  it('the parser says which prop feeds the default-fed text, so the planner writes the call site and the component is untouched', async () => {
    const { after, card } = await afterFirstOverride()
    const other = elementOf(after, after.instances[1]!, 'h3')
    expect(other.propFeeds).toEqual({ text: 'heading' })
    // Still code in the markup, with no origin: the feed is the write target, not a baked literal.
    expect(other.codeProps).toContain('text')
    expect(other.textOrigin).toBeUndefined()

    const plan = planFor(after, other, { props: { text: 'Another' } })
    expect(plan).toEqual({ kind: 'override', overrides: [{ key: 'text', target: { kind: 'text' }, propName: 'heading', value: 'Another', fed: true }] })
    if (plan.kind !== 'override') return

    const othersBefore = [rendered(after, after.instances[0]!), rendered(after, after.instances[2]!)]
    const result = applyStudioEditBatch(dir, [exposeEdit(other, plan.overrides)], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    // The component is byte-identical; only the second instance's call site gained the attribute.
    expect(read('components/RoomCard.tsx')).toBe(card)
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" heading="Another" />')
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Oak room" heading="Committee room" />')

    const final = await board()
    expect(final.instances.map((instance) => (elementOf(final, instance, 'h3').props as { text: string }).text)).toEqual(['Committee room', 'Another', 'Main hall'])
    expect([rendered(final, final.instances[0]!), rendered(final, final.instances[2]!)]).toEqual(othersBefore)

    // One restore puts the second instance back; the first override is still there.
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" />')
    expect(read('components/RoomCard.tsx')).toBe(card)
  })

  it('an inline style stays editable per instance: a number replaces a number, and another primitive widens the prop type', async () => {
    const before = await board()
    await override(before, elementOf(before, before.instances[2]!, 'p'), { styles: { opacity: 0.3 } })
    const mid = await board()
    const card = read('components/RoomCard.tsx')
    expect(card).toContain('opacityValue?: number')

    // Instance 1 never overrode it: default-fed, so the call site gains the attribute.
    const elm = elementOf(mid, mid.instances[1]!, 'p')
    expect(elm.propFeeds).toEqual({ 'style:opacity': 'opacityValue' })
    const addPlan = planFor(mid, elm, { styles: { opacity: 0.5 } })
    if (addPlan.kind !== 'override') throw new Error(JSON.stringify(addPlan))
    expect(applyStudioEditBatch(dir, [exposeEdit(elm, addPlan.overrides)], {}, EDITOR).refusals).toEqual([])
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" opacityValue={0.5} />')
    expect(read('components/RoomCard.tsx')).toBe(card)

    // Instance 2 passes a numeric literal (no origin: only strings carry one): its second edit replaces it in place.
    const again = await board()
    const birch = elementOf(again, again.instances[2]!, 'p')
    const replacePlan = planFor(again, birch, { styles: { opacity: 0.9 } })
    if (replacePlan.kind !== 'override') throw new Error(JSON.stringify(replacePlan))
    expect(applyStudioEditBatch(dir, [exposeEdit(birch, replacePlan.overrides)], {}, EDITOR).refusals).toEqual([])
    expect(read('pages/Hire.tsx')).toContain('<RoomCard name="Birch room" opacityValue={0.9} />')

    // Instance 0 gets a string: the declared `number` is widened, once, and the call site passes the string.
    const now = await board()
    const oak = elementOf(now, now.instances[0]!, 'p')
    const widenPlan = planFor(now, oak, { styles: { opacity: '50%' } })
    if (widenPlan.kind !== 'override') throw new Error(JSON.stringify(widenPlan))
    const widened = applyStudioEditBatch(dir, [exposeEdit(oak, widenPlan.overrides)], {}, EDITOR)
    expect(widened.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toContain('opacityValue?: number | string')
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Oak room" opacityValue="50%" />')
    expect(applyStudioEditBatch(dir, [restore(widened.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toContain('opacityValue?: number')
    expect(read('components/RoomCard.tsx')).not.toContain('number | string')
  })

  it('Apply to all after a fed edit makes the value the default and drops it from the call site', async () => {
    const { after } = await afterFirstOverride()
    const elm = elementOf(after, after.instances[1]!, 'h3')
    const plan = planFor(after, elm, { props: { text: 'Gallery' } })
    if (plan.kind !== 'override') throw new Error(JSON.stringify(plan))
    expect(applyStudioEditBatch(dir, [exposeEdit(elm, plan.overrides)], {}, EDITOR).refusals).toEqual([])
    const mid = await board()
    const promoted = applyStudioEditBatch(dir, [{ kind: 'promote-override', nodeId: mid.instances[1]!.children[0]!, propNames: ['heading'] }], {}, EDITOR)
    expect(promoted.refusals).toEqual([])
    expect(read('components/RoomCard.tsx')).toContain("heading = 'Gallery'")
    expect(read('pages/Rooms.tsx')).toContain('<RoomCard name="Elm room" />')
    const final = await board()
    // Instance 0 keeps its own override; the others show the new default.
    expect(final.instances.map((instance) => (elementOf(final, instance, 'h3').props as { text: string }).text)).toEqual(['Committee room', 'Gallery', 'Gallery'])
  })

  it('refuses by name, writing nothing: a prop that feeds two places, a call site that passes code, a spread that could still win', async () => {
    const { after, card, rooms } = await afterFirstOverride()
    const elm = elementOf(after, after.instances[1]!, 'h3')
    const plan = planFor(after, elm, { props: { text: 'Another' } })
    if (plan.kind !== 'override') throw new Error(JSON.stringify(plan))
    const edit = exposeEdit(elm, plan.overrides)

    // The same prop also labels the image: setting it would change a place the user did not point at.
    write('components/RoomCard.tsx', card.replace('alt="Hall photo"', 'alt={heading}'))
    const twice = read('components/RoomCard.tsx')
    const shared = applyStudioEditBatch(dir, [edit], {}, EDITOR)
    expect(shared.refusals.map((refusal) => refusal.reason)).toEqual(['shared-prop'])
    expect(read('components/RoomCard.tsx')).toBe(twice)
    expect(read('pages/Rooms.tsx')).toBe(rooms)
    // ...and the parser does not even offer it: the second read removes the feed.
    const twiceBoard = await board()
    expect(elementOf(twiceBoard, twiceBoard.instances[1]!, 'h3').propFeeds).toBeUndefined()
    write('components/RoomCard.tsx', card)

    // The instance passes the prop as code: never overwritten with a literal.
    write('pages/Rooms.tsx', rooms.replace('<RoomCard name="Elm room" />', '<RoomCard name="Elm room" heading={title} />'))
    const coded = read('pages/Rooms.tsx')
    const codeRefusal = applyStudioEditBatch(dir, [edit], {}, EDITOR)
    expect(codeRefusal.refusals.map((refusal) => refusal.reason)).toEqual(['not-a-literal'])
    expect(read('pages/Rooms.tsx')).toBe(coded)
    const codeBoard = await board()
    const codeNode = elementOf(codeBoard, codeBoard.instances[1]!, 'h3')
    expect(planFor(codeBoard, codeNode, { props: { text: 'Another' } })).toEqual({ kind: 'direct' })

    // A spread after the attribute could override the value written.
    write('pages/Rooms.tsx', rooms.replace('<RoomCard name="Elm room" />', '<RoomCard name="Elm room" heading="Old" {...extra} />'))
    const spread = read('pages/Rooms.tsx')
    expect(applyStudioEditBatch(dir, [edit], {}, EDITOR).refusals.map((refusal) => refusal.reason)).toEqual(['call-site-spread'])
    expect(read('pages/Rooms.tsx')).toBe(spread)
  })

  it('a prop typed as a fixed set of values refuses to be widened, and nothing is written', async () => {
    const { after, rooms } = await afterFirstOverride()
    write('components/RoomCard.tsx', read('components/RoomCard.tsx').replace('heading?: string', "heading?: 'Main hall' | 'Hall'"))
    const typed = read('components/RoomCard.tsx')
    const elm = elementOf(after, after.instances[1]!, 'h3')
    // A number for a string-typed prop needs the type widened, which a fixed set of values refuses.
    const refused = applyStudioEditBatch(dir, [{ kind: 'expose-prop', nodeId: elm.id, overrides: [{ target: { kind: 'text' }, propName: 'heading', value: 3 }] }], {}, EDITOR)
    expect(refused.refusals.map((refusal) => refusal.reason)).toEqual(['unsupported-props-type'])
    expect(read('components/RoomCard.tsx')).toBe(typed)
    expect(read('pages/Rooms.tsx')).toBe(rooms)
  })
})
