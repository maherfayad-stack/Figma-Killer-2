/**
 * Array- and object-valued props on a COMPONENT reach the node.
 *
 * Before this, `ParsedNode.props` was `string | number | boolean`, so
 * `<ActionSheet actions={[{ label, onClick }]}/>` arrived with no actions and the
 * design-system component rendered its title alone — the device-picker screen in
 * the eSIM corpus was a heading over empty space. Same for `<TabBar items={…}/>`
 * (5 tabs) and `<SegmentedControl items={…}/>`.
 *
 * The lines this must not cross are all about not overstating what the source
 * says: a function entry is dropped rather than stubbed, one unresolved item
 * declines the whole array rather than silently shortening it, and an HTML
 * element never gets a structured value at all (an attribute is a string).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  parsePageFile,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'
import { decodeSourceNodeId, hasWritableSourceLocation, isSourceDerivedNodeId } from '@core/page-tree'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-props-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** `opts` is explicit — passing `undefined` to a defaulted param would silently re-enable the evaluator. */
function loadNodes(pageRel: string, opts: StaticEvalOptions | undefined): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  return Object.values(parsePageFile(file, tmpDir, project, opts).nodes)
}

const named = (nodes: ParsedNode[], name: string): ParsedNode => {
  const found = nodes.find((n) => n.name === name)
  if (!found) throw new Error(`No node named ${name} in ${nodes.map((n) => n.name).join(', ')}`)
  return found
}

describe('structured component props', () => {
  it('captures an inline array of objects', () => {
    write(
      'pages/Sheet.jsx',
      [
        'export default function Sheet() {',
        '  return (',
        '    <ActionSheet',
        '      title="Where do you want to install this eSIM?"',
        '      actions={[{ label: "This device" }, { label: "Another device" }]}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const sheet = named(loadNodes('pages/Sheet.jsx', evalOptions()), 'ActionSheet')
    expect(sheet.props.actions).toEqual([{ label: 'This device' }, { label: 'Another device' }])
    expect(sheet.props.title).toBe('Where do you want to install this eSIM?')
  })

  it('resolves the array through a binding, and resolves each item\'s fields', () => {
    write(
      'pages/Tabs.jsx',
      [
        'const LABELS = { home: "Home", trips: "My Trips" }',
        'export default function Tabs() {',
        '  return <TabBar items={[{ label: LABELS.home }, { label: LABELS.trips }]} value={0} />',
        '}',
        '',
      ].join('\n'),
    )

    const tabs = named(loadNodes('pages/Tabs.jsx', evalOptions()), 'TabBar')
    expect(tabs.props.items).toEqual([{ label: 'Home' }, { label: 'My Trips' }])
    expect(tabs.props.value).toBe(0)
  })

  it('captures a plain array of strings', () => {
    write(
      'pages/Segments.jsx',
      [
        'export default function Segments() {',
        '  return <SegmentedControl items={["Data", "Days"]} value={0} />',
        '}',
        '',
      ].join('\n'),
    )

    const seg = named(loadNodes('pages/Segments.jsx', evalOptions()), 'SegmentedControl')
    expect(seg.props.items).toEqual(['Data', 'Days'])
  })

  it('drops a function entry rather than stubbing it', () => {
    write(
      'pages/Sheet.jsx',
      [
        'export default function Sheet({ onPick }) {',
        '  return <ActionSheet actions={[{ label: "Pick", onClick: onPick }]} />',
        '}',
        '',
      ].join('\n'),
    )

    // The label is what renders; a handler has no JSON form, and a placeholder
    // would claim a behaviour the source does not have.
    const sheet = named(loadNodes('pages/Sheet.jsx', evalOptions()), 'ActionSheet')
    expect(sheet.props.actions).toEqual([{ label: 'Pick' }])
  })

  it('declines the whole array when one item does not resolve', () => {
    write(
      'pages/Mixed.jsx',
      [
        'export default function Mixed({ extra }) {',
        '  return <TabBar items={["Home", extra]} />',
        '}',
        '',
      ].join('\n'),
    )

    // Keeping only "Home" would read as a one-tab bar rather than an unread list.
    expect(named(loadNodes('pages/Mixed.jsx', evalOptions()), 'TabBar').props.items).toBeUndefined()
  })

  it('declines an object whose every entry was dropped', () => {
    write(
      'pages/Empty.jsx',
      [
        'export default function Empty({ onA, onB }) {',
        '  return <Thing handlers={{ onA, onB }} />',
        '}',
        '',
      ].join('\n'),
    )

    // Absent, so the component falls back to its own default — an empty object
    // would be a claim that the prop was read.
    expect(named(loadNodes('pages/Empty.jsx', evalOptions()), 'Thing').props.handlers).toBeUndefined()
  })

  it('does not lock the node, so its scalar props stay editable', () => {
    write(
      'pages/Sheet.jsx',
      [
        'export default function Sheet() {',
        '  return <ActionSheet title="Pick one" actions={[{ label: "A" }]} />',
        '}',
        '',
      ].join('\n'),
    )

    // A resolved SCALAR locks the node, because writing an edit back would bake
    // over the binding. A structured value is not a writeback target at all
    // (`setJsxProp` takes scalars only), so locking here would cost the user the
    // ability to edit `title` for no protection.
    const sheet = named(loadNodes('pages/Sheet.jsx', evalOptions()), 'ActionSheet')
    expect(sheet.locked).toBe(false)
    expect(sheet.resolution).toBeUndefined()
  })

  it('leaves an HTML element scalar-only', () => {
    write(
      'pages/El.jsx',
      [
        'export default function El() {',
        '  return <div data-config={{ a: 1 }} className="row" />',
        '}',
        '',
      ].join('\n'),
    )

    // An HTML attribute is a string — an object there could only stringify.
    const div = named(loadNodes('pages/El.jsx', evalOptions()), 'div')
    expect(div.props['data-config']).toBeUndefined()
    expect(div.props.className).toBe('row')
  })

  it('does not duplicate style or dangerouslySetInnerHTML into props', () => {
    write(
      'pages/Icon.jsx',
      [
        'const MARKUP = "<svg viewBox=\\"0 0 1 1\\"></svg>"',
        'export default function Icon() {',
        '  return <Badge style={{ width: 24 }} dangerouslySetInnerHTML={{ __html: MARKUP }} />',
        '}',
        '',
      ].join('\n'),
    )

    // `extractInlineStyles` owns `style` and `extractRawSvgMarkup` owns the raw
    // markup (promoting it to `svg`). A second copy in `props` would reach the
    // canvas as a meaningless prop and, for `style`, fight the real one.
    const badge = named(loadNodes('pages/Icon.jsx', evalOptions()), 'Badge')
    expect(badge.props.style).toBeUndefined()
    expect(badge.props.dangerouslySetInnerHTML).toBeUndefined()
    expect(badge.inlineStyles).toEqual({ width: 24 })
    expect(badge.props.svg).toContain('<svg')
  })

  it('captures nothing structured when the evaluator is off', () => {
    write(
      'pages/Sheet.jsx',
      [
        'export default function Sheet() {',
        '  return <ActionSheet actions={[{ label: "A" }]} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(named(loadNodes('pages/Sheet.jsx', undefined), 'ActionSheet').props.actions).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// JSX-valued icon props
// ---------------------------------------------------------------------------

describe('JSX-valued icon props', () => {
  const SVG = '<svg viewBox="0 0 24 24"><path d="M1 1h4" /></svg>'

  it('captures the markup an icon element renders, as { svg }', () => {
    write('assets/reward.svg', SVG)
    write(
      'pages/Rewards.jsx',
      [
        "import rewardSvg from '../assets/reward.svg?raw'",
        'export default function Rewards() {',
        '  return <Cell visual="icon" icon={<Icon svg={rewardSvg} size={24} />} label="Points" />',
        '}',
        '',
      ].join('\n'),
    )

    // A React element has no JSON form, so this prop used to be skipped and the
    // cell rendered with an empty visual slot. `svg` is the same key a node
    // carrying raw markup uses — the module layer turns it back into an element.
    const cell = named(loadNodes('pages/Rewards.jsx', evalOptions()), 'Cell')
    expect(cell.props.icon).toEqual({ svg: SVG })
    expect(cell.props.label).toBe('Points')
  })

  it('reads a dangerouslySetInnerHTML icon element too', () => {
    write('assets/share.svg', SVG)
    write(
      'pages/Share.jsx',
      [
        "import shareSvg from '../assets/share.svg?raw'",
        'export default function Share() {',
        '  return <GlassButton icon1={<span dangerouslySetInnerHTML={{ __html: shareSvg }} />} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(named(loadNodes('pages/Share.jsx', evalOptions()), 'GlassButton').props.icon1).toEqual({ svg: SVG })
  })

  it('WS-3.4 — a JSX prop that renders no raw markup is materialized as a real slot child instead of dropped', () => {
    write(
      'pages/Layout.jsx',
      [
        'export default function Layout() {',
        '  return <Cell icon={<div className="wrap"><span /></div>} />',
        '}',
        '',
      ].join('\n'),
    )

    // `iconPropFromJsx` still declines (one level deep, no raw markup) — but
    // `captureSlotProps` (`parsePageFile.ts`) now materializes the whole
    // subtree as a real child node instead of dropping the prop. The sentinel
    // names that node's id; the actual `<div className="wrap"><span/></div>`
    // structure survives as ordinary nodes in the flat tree.
    const nodes = loadNodes('pages/Layout.jsx', evalOptions())
    const cell = named(nodes, 'Cell')
    const icon = cell.props.icon
    expect(typeof icon).toBe('string')
    const slotId = (icon as string).replace(/^studio-slot:/, '')
    expect(slotId).not.toBe(icon) // proves the prefix was actually present

    const slotDiv = nodes.find((n) => n.id === slotId)
    expect(slotDiv).toBeDefined()
    expect(slotDiv!.name).toBe('div')
    expect(slotDiv!.locked).toBe(true)
    expect(slotDiv!.children.length).toBe(1)
    const span = nodes.find((n) => n.id === slotDiv!.children[0])
    expect(span?.name).toBe('span')
    // Not a normal DOM child of Cell — only reachable via the sentinel.
    expect(cell.children).not.toContain(slotId)
  })
})

describe('E2.3 — fragment-valued slots (studio.slot)', () => {
  it('captures a multi-element (fragment) slot value as a studio.slot container at the FRAGMENT\'s own source location', () => {
    write(
      'pages/SheetLayout.jsx',
      [
        'export default function SheetLayout() {',
        '  return (',
        '    <Sheet',
        '      header={',
        '        <>',
        '          <BackButton />',
        '          <span>Title</span>',
        '        </>',
        '      }',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/SheetLayout.jsx', evalOptions())
    const sheet = named(nodes, 'Sheet')
    const headerValue = sheet.props.header
    expect(typeof headerValue).toBe('string')
    const slotId = studioSlotNodeId(headerValue)
    expect(slotId).toBeDefined()
    expect(slotId).not.toBe(headerValue) // proves the sentinel prefix was actually present

    // ⚠️ The published id grammar E2.4/E2.5 depend on: a real, decodable
    // `rel:line:col` — the fragment's OWN location, never a minted id. A
    // minted id here would make `refuseMintedNodeInsert` correctly (but for
    // the wrong stated reason) refuse every future insert into this slot.
    expect(isSourceDerivedNodeId(slotId!)).toBe(true)
    expect(hasWritableSourceLocation(slotId!)).toBe(true)
    // Line 5, column 9 — where `<>` (the fragment's own opening) sits.
    expect(decodeSourceNodeId(slotId!)).toEqual({ rel: 'pages/SheetLayout.jsx', line: 5, col: 9 })

    const container = nodes.find((n) => n.id === slotId)
    expect(container).toBeDefined()
    // Structurally locked — the whole point is it cannot be dragged out of
    // the slot — but its CHILDREN are real, ordinary nodes underneath it.
    expect(container!.locked).toBe(true)
    expect(container!.children.length).toBe(2)

    const back = nodes.find((n) => n.id === container!.children[0])
    const title = nodes.find((n) => n.id === container!.children[1])
    expect(back?.name).toBe('BackButton')
    expect(title?.name).toBe('span')
    expect(title?.text).toBe('Title')

    // Not a normal DOM child of Sheet — only reachable via the sentinel,
    // exactly like the single-element slot case above.
    expect(sheet.children).not.toContain(slotId)
  })

  it('a declared-but-unfilled slot prop produces NO node — the tree stays honest about what source actually places', () => {
    write(
      'pages/Bare.jsx',
      ['export default function Bare() {', '  return <Sheet title="Confirm" />', '}', ''].join('\n'),
    )

    const nodes = loadNodes('pages/Bare.jsx', evalOptions())
    const sheet = named(nodes, 'Sheet')

    // No `header` prop was ever written at the call site, so nothing about a
    // slot named `header` should exist anywhere — not on `props`, and not as
    // a materialized placeholder node. The panel is expected to learn that
    // `Sheet` HAS a `header` slot from E1's component catalog, not from here.
    expect(sheet.props.header).toBeUndefined()
    expect(Object.keys(sheet.props)).toEqual(['title'])
    expect(nodes.length).toBe(1) // just the call site itself — no phantom slot node
  })

  it('a single-element slot on the SAME call site as a fragment slot round-trips exactly as before — no cross-talk between the two capture paths', () => {
    write(
      'pages/Mixed.jsx',
      [
        'export default function Mixed() {',
        '  return (',
        '    <Sheet',
        '      icon={<Icon name="star" />}',
        '      header={',
        '        <>',
        '          <BackButton />',
        '          <CloseButton />',
        '        </>',
        '      }',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Mixed.jsx', evalOptions())
    const sheet = named(nodes, 'Sheet')

    const iconSlotId = studioSlotNodeId(sheet.props.icon)
    const headerSlotId = studioSlotNodeId(sheet.props.header)
    expect(iconSlotId).toBeDefined()
    expect(headerSlotId).toBeDefined()
    expect(iconSlotId).not.toBe(headerSlotId)

    // The single-element slot mints an ORDINARY node, exactly the pre-E2.3
    // shape — no `studio.slot`-only marker, no forced fragment wrapper.
    const iconNode = nodes.find((n) => n.id === iconSlotId)
    expect(iconNode?.name).toBe('Icon')
    expect(iconNode?.fragmentSlot).toBeUndefined()
    expect(iconNode?.locked).toBe(true)
    expect(iconNode?.children.length).toBe(0)

    // The fragment slot mints the container, as its own test above proves.
    const headerNode = nodes.find((n) => n.id === headerSlotId)
    expect(headerNode?.fragmentSlot).toBe(true)
    expect(headerNode?.children.length).toBe(2)
  })
})
