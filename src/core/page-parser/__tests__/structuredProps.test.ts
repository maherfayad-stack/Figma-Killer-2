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

  it('a function entry LITERALLY written in the object is dropped but its PATH is traced', () => {
    write(
      'pages/Nav.jsx',
      [
        'export default function Nav() {',
        '  return <Navbar toolbar={{ variant: "default", title: "Account", onBack: () => {} }} surface="default" />',
        '}',
        '',
      ].join('\n'),
    )

    // `onPick` above was an identifier bound to an undestructured param
    // (`unresolved`, not `{kind:'fn'}`) — a literal `() => {}` written INSIDE
    // the object is what a design-system component actually gates a visible
    // affordance on (`<Navbar>` draws its leading back button only when
    // `toolbar.onBack` is present). The value is still dropped, exactly like
    // the array case above, but the PATH survives so a module can stand a
    // no-op back up at exactly that key.
    const navbar = named(loadNodes('pages/Nav.jsx', evalOptions()), 'Navbar')
    expect(navbar.props.toolbar).toEqual({ variant: 'default', title: 'Account' })
    expect(navbar.codeFunctionPaths).toEqual(['toolbar.onBack'])
    expect(navbar.codeProps).toContain('toolbar')
  })

  it('traces a function path inside an ARRAY item too, and does not lock the node', () => {
    write(
      'pages/Sheet.jsx',
      [
        'export default function Sheet() {',
        '  return <ActionSheet actions={[{ label: "Pick", onClick: () => {} }]} />',
        '}',
        '',
      ].join('\n'),
    )

    const sheet = named(loadNodes('pages/Sheet.jsx', evalOptions()), 'ActionSheet')
    expect(sheet.props.actions).toEqual([{ label: 'Pick' }])
    expect(sheet.codeFunctionPaths).toEqual(['actions[0].onClick'])
    // Same rule as every other resolution: a VALUE fact, never a structural one.
    expect(sheet.locked).toBe(false)
  })

  it('still traces the function path even when the object has NOTHING else to keep', () => {
    write(
      'pages/Nav.jsx',
      [
        'export default function Nav() {',
        '  return <Navbar toolbar={{ onBack: () => {} }} />',
        '}',
        '',
      ].join('\n'),
    )

    // `staticValueToPropValue`'s "empty object declines" rule still applies to
    // the VALUE — there is nothing else to show — but the function's location
    // is a separate fact about the same expression and must survive regardless.
    const navbar = named(loadNodes('pages/Nav.jsx', evalOptions()), 'Navbar')
    expect(navbar.props.toolbar).toBeUndefined()
    expect(navbar.codeFunctionPaths).toEqual(['toolbar.onBack'])
    expect(navbar.codeProps).toContain('toolbar')
  })

  it('captures no function paths when the evaluator is off', () => {
    write(
      'pages/Nav.jsx',
      [
        'export default function Nav() {',
        '  return <Navbar toolbar={{ title: "Account", onBack: () => {} }} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(named(loadNodes('pages/Nav.jsx', undefined), 'Navbar').codeFunctionPaths).toBeUndefined()
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

describe('a JSX icon NESTED inside a structured prop', () => {
  /**
   * `items={[{ icon: <svg…/>, label: 'Home' }]}` is the documented shape of a
   * `TabBar`, and the readers only ever looked at the TOP of an attribute. The
   * evaluator reached the nested element, had no kind for a React element, and
   * dropped the entry — an object that loses one key is still an object — so
   * the canvas drew correct labels above five empty icon slots.
   *
   * `{ svg: markup }` is the same shape a top-level icon prop is captured as
   * (`ICON_PROP_SVG_KEY`), read at one more level of depth rather than being a
   * second convention.
   */
  it('captures an inline <svg> element as { svg }', () => {
    write(
      'pages/Home.jsx',
      [
        'export default function Home() {',
        '  return (',
        '    <TabBar',
        '      items={[',
        '        { icon: <svg viewBox="0 0 24 24"><path d="M4 12L9 17" /></svg>, label: "Home" },',
        '        { icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>, label: "Explore" },',
        '      ]}',
        '      value={0}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const tabBar = named(loadNodes('pages/Home.jsx', evalOptions()), 'TabBar')
    const items = tabBar.props?.items as { icon?: { svg?: string }; label?: string }[]
    expect(items).toHaveLength(2)
    expect(items[0]?.label).toBe('Home')
    expect(items[0]?.icon?.svg).toContain('<svg')
    expect(items[0]?.icon?.svg).toContain('M4 12L9 17')
    expect(items[1]?.label).toBe('Explore')
    expect(items[1]?.icon?.svg).toContain('<circle')
  })

  it('captures the wrapper shapes a real project writes', () => {
    // `<span dangerouslySetInnerHTML={{ __html: raw }}/>` is what the package's
    // own icon reference tells an agent to write for a `?raw` SVG import, and
    // `<Icon svg={…}/>` is the corpus's other form. Both already worked at the
    // top of a prop; neither did one level down.
    write(
      'pages/Home.jsx',
      [
        'const homeIcon = \'<svg viewBox="0 0 24 24"><path d="M1 2" /></svg>\'',
        'export default function Home() {',
        '  return (',
        '    <TabBar',
        '      items={[{ icon: <span dangerouslySetInnerHTML={{ __html: homeIcon }} />, label: "Home" }]}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const items = named(loadNodes('pages/Home.jsx', evalOptions()), 'TabBar').props?.items as {
      icon?: { svg?: string }
      label?: string
    }[]
    expect(items[0]?.icon?.svg).toContain('M1 2')
    expect(items[0]?.label).toBe('Home')
  })

  it('leaves an item whose icon is not resolvable exactly as it was', () => {
    // A component element that only materializes after inlining carries no
    // markup here. The LABEL must still survive — a tab with no icon beats no
    // tab at all — and nothing may be invented in the icon's place.
    write(
      'pages/Home.jsx',
      [
        'export default function Home() {',
        '  return <TabBar items={[{ icon: <SomeIcon />, label: "Home" }]} />',
        '}',
        '',
      ].join('\n'),
    )

    const items = named(loadNodes('pages/Home.jsx', evalOptions()), 'TabBar').props?.items as Record<
      string,
      unknown
    >[]
    expect(items[0]?.label).toBe('Home')
    expect(items[0]?.icon).toBeUndefined()
  })

  it('declines the whole prop rather than misplacing an icon when the array cannot be read', () => {
    // The walk matches the AST to the resolved value BY POSITION, so a
    // mismatched length must never shift one tab's icon onto another. Today an
    // array holding a spread declines outright one layer down (an unresolved
    // ITEM declines the array — `staticValueToPropValue`'s own rule), so the
    // length guard in `withNestedIconValues` never fires for this input. It
    // stays because that rule is not this walk's to depend on: if the evaluator
    // ever learns to flatten a spread, the counts diverge and the guard is what
    // keeps every icon on its own tab.
    write(
      'pages/Home.jsx',
      [
        'const extra = [{ label: "Trips" }, { label: "Profile" }]',
        'export default function Home() {',
        '  return (',
        '    <TabBar items={[{ icon: <svg viewBox="0 0 24 24"><path d="M9 9" /></svg>, label: "Home" }, ...extra]} />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const items = named(loadNodes('pages/Home.jsx', evalOptions()), 'TabBar').props?.items
    // Nothing invented: either the prop is absent, or every icon sits on the
    // item that was written with one.
    if (items !== undefined) {
      for (const [index, item] of (items as Record<string, unknown>[]).entries()) {
        if (item.icon !== undefined) expect(index).toBe(0)
      }
    }
    expect(items).toBeUndefined()
  })
})

describe('a translated label inside a structured prop', () => {
  /**
   * The state a tab bar ends up in after the Content panel extracts its copy:
   * `label` is no longer a literal, it is `t.tabs.home`. If the evaluator
   * cannot follow that INSIDE the array, extracting the labels — the thing that
   * makes the bar translatable — is what empties it, and the author is punished
   * for doing the right thing.
   *
   * The `t.x.y` resolution itself is Tier B and already gated in
   * `staticEval.test.ts`; what is gated here is that it survives one level down,
   * beside an icon the same walk had to leave alone.
   */
  function writeLanguageContext(): void {
    write(
      'translations.ts',
      "export const translations = { en: { tabs: { home: 'Home', explore: 'Explore' } }, ar: { tabs: { home: 'الرئيسية', explore: 'استكشف' } } }",
    )
    write(
      'LanguageContext.tsx',
      [
        "import { createContext, useContext, useMemo, useState } from 'react'",
        "import { translations } from './translations'",
        'const LanguageContext = createContext(null)',
        'export function LanguageProvider({ children }) {',
        "  const [lang, setLang] = useState('en')",
        '  const value = useMemo(() => ({ lang, t: translations[lang] }), [lang])',
        '  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>',
        '}',
        'export function useLanguage() {',
        '  const ctx = useContext(LanguageContext)',
        "  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')",
        '  return ctx',
        '}',
      ].join('\n'),
    )
  }

  function writeTabBarPage(): void {
    write(
      'pages/Home.jsx',
      [
        "import { useLanguage } from '../LanguageContext'",
        'export default function Home() {',
        '  const { t } = useLanguage()',
        '  return (',
        '    <TabBar',
        '      items={[',
        '        { icon: <svg viewBox="0 0 24 24"><path d="M4 12L9 17" /></svg>, label: t.tabs.home },',
        '        { icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>, label: t.tabs.explore },',
        '      ]}',
        '      value={0}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
  }

  it('renders the translated label, and keeps the icon beside it', () => {
    writeLanguageContext()
    writeTabBarPage()
    const items = named(loadNodes('pages/Home.jsx', evalOptions()), 'TabBar').props?.items as {
      icon?: { svg?: string }
      label?: string
    }[]
    expect(items.map((item) => item.label)).toEqual(['Home', 'Explore'])
    expect(items[0]?.icon?.svg).toContain('<svg')
    expect(items[1]?.icon?.svg).toContain('<circle')
  })

  it('follows the previewed locale', () => {
    // The board's AR toggle has to reach a label one level inside a prop, or an
    // Arabic frame renders a Latin tab bar over an Arabic screen.
    writeLanguageContext()
    writeTabBarPage()
    const items = named(
      loadNodes('pages/Home.jsx', { ...evalOptions(), preferredKey: 'ar' }),
      'TabBar',
    ).props?.items as { label?: string }[]
    expect(items.map((item) => item.label)).toEqual(['الرئيسية', 'استكشف'])
  })
})
