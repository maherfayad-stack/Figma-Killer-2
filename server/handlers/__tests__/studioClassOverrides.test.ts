/**
 * G-2b on REAL projects: a class-styled value edited inside ONE instance of a
 * shared component changes that instance and no other.
 *
 * Nothing here is a hand-built tree. A temp project is written to disk and read
 * back by the real board loader (`loadStudioPages`); the edits go through the
 * real `/save` batch engine (`applyStudioEditBatch`, journaled like the
 * editor's); the files are parsed AGAIN to see what every instance renders. The
 * default-preservation promise is asserted the way a user would see it: the
 * other instances' classes and the stylesheet, before and after.
 *
 * The project (a pricing page with tier cards) shares nothing with the eSIM
 * corpus and nothing with `studioInstanceOverrides.test.ts`'s village hall.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import type { Page, PageNode, StyleRule } from '@core/page-tree'
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

const TIER = [
  "import './Tier.css'",
  'interface TierProps { name: string; price: number }',
  'export function Tier({ name, price }: TierProps) {',
  '  return (',
  '    <section className="tier">',
  '      <h3 className="tier__name">{name}</h3>',
  '      <p className="tier__price">{price}</p>',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')

const TIER_CSS = ['.tier {', '  padding: 8px;', '  border: 1px solid #ccc;', '}', '', '.tier__name {', '  font-weight: 600;', '}', ''].join('\n')

const HOME = [
  "import { Tier } from '../components/Tier'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Tier name="Basic" price={5} />',
  '      <Tier name="Plus" price={9} />',
  '      <Tier name="Pro" price={19} />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const ALL = ['components/Tier.tsx', 'components/Tier.css', 'pages/Home.tsx']

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-class-overrides-')))
  write('components/Tier.tsx', TIER)
  write('components/Tier.css', TIER_CSS)
  write('pages/Home.tsx', HOME)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Board {
  pages: Page[]
  styleRules: Record<string, StyleRule>
  /** The `Tier` instances of Home, in source order. */
  instances: PageNode[]
}

async function board(component = 'Tier'): Promise<Board> {
  const loaded = await loadStudioPages(dir)
  const order = (node: PageNode) => Number(/:(\d+):\d+$/.exec(node.id)?.[1] ?? 0)
  const instances = loaded.pages
    .flatMap((page) => Object.values(page.nodes))
    .filter((node) => node.moduleId === 'studio.instance' && (node.props as { componentName?: string }).componentName === component && node.id.startsWith('pages/'))
    .sort((a, b) => order(a) - order(b))
  return { pages: loaded.pages, styleRules: loaded.styleRules, instances }
}

const rootOf = (b: Board, instance: PageNode): PageNode => b.pages.flatMap((page) => Object.values(page.nodes)).find((node) => node.id === instance.children[0])!

/** The class names an instance's root renders, from the registry. */
function classesOf(b: Board, instance: PageNode): string[] {
  return (rootOf(b, instance).classIds ?? []).map((id) => b.styleRules[id]?.name ?? id)
}

const exposeClass = (rootId: string, declarations: Record<string, string>, extra: { file?: string; selector?: string; atRule?: string } = {}): StudioEdit => ({
  kind: 'expose-class',
  nodeId: rootId,
  file: extra.file ?? 'components/Tier.css',
  selector: extra.selector ?? '.tier',
  declarations,
  ...(extra.atRule ? { atRule: extra.atRule } : {}),
})

function snapshot(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file, read(file)]))
}

describe('a class edit inside one instance changes only that instance', () => {
  it('plain CSS: the instance takes a modifier class, a rule one class more specific carries the value, and one restore puts all three files back', async () => {
    const before = await board()
    expect(before.instances).toHaveLength(3)
    const [first, second, third] = before.instances
    const othersBefore = [classesOf(before, first!), classesOf(before, third!)]
    const original = snapshot(ALL)

    const result = applyStudioEditBatch(dir, [exposeClass(second!.children[0]!, { padding: '20px' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)

    expect(read('pages/Home.tsx')).toContain('<Tier name="Plus" price={9} className="tier-home-2" />')
    expect(read('pages/Home.tsx')).toContain('<Tier name="Basic" price={5} />')
    expect(read('components/Tier.tsx')).toContain("<section className={`tier ${className || ''}`}>")
    expect(read('components/Tier.tsx')).toContain('{ name, price, className }: TierProps')
    expect(read('components/Tier.tsx')).toContain('interface TierProps { name: string; price: number; className?: string }')
    // The component's own rule is untouched; the modifier sits right after it.
    expect(read('components/Tier.css')).toBe(
      ['.tier {', '  padding: 8px;', '  border: 1px solid #ccc;', '}', '', '.tier.tier-home-2 {', '  padding: 20px;', '}', '', '.tier__name {', '  font-weight: 600;', '}', ''].join('\n'),
    )

    // What every instance renders: the edited one carries the modifier, the others exactly what they did.
    const after = await board()
    expect(classesOf(after, after.instances[0]!)).toEqual(othersBefore[0]!)
    expect(classesOf(after, after.instances[2]!)).toEqual(othersBefore[1]!)
    expect(classesOf(after, after.instances[1]!)).toEqual(['tier', 'tier-home-2'])
    const modifier = Object.values(after.styleRules).find((rule) => rule.name === 'tier-home-2')!
    expect(modifier.styles).toMatchObject({ paddingTop: '20px', paddingLeft: '20px' })

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(snapshot(ALL)).toEqual(original)
  })

  it('a colour over a var() binding writes the literal to the instance's own rule and leaves the component's variable alone', async () => {
    write('components/Tier.css', `:root {
  --probe-accent: #cc0000;
}

.tier {
  padding: 8px;
  color: var(--probe-accent);
}
`)
    const before = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(before.instances[0]!.children[0]!, { color: '#00aa00' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.css')).toBe(
      `:root {
  --probe-accent: #cc0000;
}

.tier {
  padding: 8px;
  color: var(--probe-accent);
}

.tier.tier-home-1 {
  color: #00aa00;
}
`,
    )
    const after = await board()
    expect(Object.values(after.styleRules).find((rule) => rule.name === 'tier')!.styles).toMatchObject({ color: 'var(--probe-accent)' })
  })

  it('a second edit of the same instance converges on the one modifier rule', async () => {
    const first = await board()
    applyStudioEditBatch(dir, [exposeClass(first.instances[1]!.children[0]!, { padding: '20px' })], {}, EDITOR)

    const mid = await board()
    const again = applyStudioEditBatch(dir, [exposeClass(mid.instances[1]!.children[0]!, { gap: '12px', padding: '24px' })], {}, EDITOR)
    expect(again.refusals).toEqual([])
    expect(read('components/Tier.css')).toContain('.tier.tier-home-2 {\n  padding: 24px;\n  gap: 12px;\n}')
    expect(read('pages/Home.tsx').match(/tier-home-2/g)).toHaveLength(1)
    expect(read('components/Tier.tsx')).toContain("<section className={`tier ${className || ''}`}>")
  })

  it('editing the modifier the instance already has writes that rule (the panel sends the rule it shows)', async () => {
    const first = await board()
    applyStudioEditBatch(dir, [exposeClass(first.instances[1]!.children[0]!, { padding: '20px' })], {}, EDITOR)
    const mid = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(mid.instances[1]!.children[0]!, { padding: '30px' }, { selector: '.tier.tier-home-2' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.css')).toContain('.tier.tier-home-2 {\n  padding: 30px;\n}')
    expect(read('pages/Home.tsx').match(/tier-home-2/g)).toHaveLength(1)
  })

  it('a breakpoint edit writes the modifier inside the same media block', async () => {
    write('components/Tier.css', `${TIER_CSS}\n@media (max-width: 600px) {\n  .tier {\n    padding: 4px;\n  }\n}\n`)
    const before = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(before.instances[0]!.children[0]!, { padding: '2px' }, { atRule: 'media (max-width: 600px)' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.css')).toContain('@media (max-width: 600px) {\n  .tier {\n    padding: 4px;\n  }\n\n  .tier.tier-home-1 {\n    padding: 2px;\n  }\n}')
  })

  it('Apply to all promotes the value into the base rule, drops the modifier, and one restore returns to the override', async () => {
    const before = await board()
    const exposed = applyStudioEditBatch(dir, [exposeClass(before.instances[1]!.children[0]!, { padding: '20px' })], {}, EDITOR)
    const overridden = snapshot(ALL)

    const mid = await board()
    const promoted = applyStudioEditBatch(
      dir,
      [{ kind: 'promote-class-override', nodeId: mid.instances[1]!.children[0]!, file: 'components/Tier.css', selector: '.tier', properties: ['padding'] }],
      {},
      EDITOR,
    )
    expect(promoted.refusals).toEqual([])
    expect(read('components/Tier.css')).toBe(['.tier {', '  padding: 20px;', '  border: 1px solid #ccc;', '}', '', '.tier__name {', '  font-weight: 600;', '}', ''].join('\n'))
    expect(read('pages/Home.tsx')).toBe(HOME)

    expect(applyStudioEditBatch(dir, [restore(promoted.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(snapshot(ALL)).toEqual(overridden)
    expect(applyStudioEditBatch(dir, [restore(exposed.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('components/Tier.css')).toBe(TIER_CSS)
    expect(read('components/Tier.tsx')).toBe(TIER)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('Apply to all of one property leaves the instance its other overrides', async () => {
    const before = await board()
    applyStudioEditBatch(dir, [exposeClass(before.instances[1]!.children[0]!, { padding: '20px', gap: '12px' })], {}, EDITOR)
    const mid = await board()
    const promoted = applyStudioEditBatch(
      dir,
      [{ kind: 'promote-class-override', nodeId: mid.instances[1]!.children[0]!, file: 'components/Tier.css', selector: '.tier', properties: ['padding'] }],
      {},
      EDITOR,
    )
    expect(promoted.refusals).toEqual([])
    expect(read('components/Tier.css')).toContain('.tier {\n  padding: 20px;')
    expect(read('components/Tier.css')).toContain('.tier.tier-home-2 {\n  gap: 12px;\n}')
    expect(read('pages/Home.tsx')).toContain('className="tier-home-2"')
  })
})

describe('the file\'s own idiom', () => {
  it('joins with cn when the file has one in scope', async () => {
    write('lib/cn.ts', 'export function cn(...parts: (string | false | undefined)[]) {\n  return parts.filter(Boolean).join(" ")\n}\n')
    write(
      'components/Tier.tsx',
      [
        "import { cn } from '../lib/cn'",
        "import './Tier.css'",
        'export function Tier({ name, wide }: { name: string; wide?: boolean }) {',
        '  return (',
        '    <section className={cn("tier", wide && "tier--wide")}>{name}</section>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    const before = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(before.instances[2]!.children[0]!, { padding: '1px' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.tsx')).toContain('<section className={cn("tier", wide && "tier--wide", className)}>')
    expect(read('components/Tier.tsx')).toContain('{ name, wide, className }: { name: string; wide?: boolean; className?: string }')
    const after = await board()
    expect(classesOf(after, after.instances[2]!)).toEqual(['tier', 'tier-home-3'])
  })

  it('leaves the component alone when its root already takes className', async () => {
    write(
      'components/Tier.tsx',
      [
        "import './Tier.css'",
        'export function Tier({ name, className }: { name: string; className?: string }) {',
        '  return <section className={`tier ${className ?? ""}`}>{name}</section>',
        '}',
        '',
      ].join('\n'),
    )
    const componentBefore = read('components/Tier.tsx')
    const before = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(before.instances[0]!.children[0]!, { padding: '1px' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.tsx')).toBe(componentBefore)
    expect(read('pages/Home.tsx')).toContain('<Tier name="Basic" price={5} className="tier-home-1" />')
  })

  it('a CSS Module spells the modifier :global() and the root joins the module member', async () => {
    write('components/Tier.module.css', '.tier {\n  padding: 8px;\n}\n')
    write(
      'components/Tier.tsx',
      ["import styles from './Tier.module.css'", 'export function Tier({ name }: { name: string }) {', '  return <section className={styles.tier}>{name}</section>', '}', ''].join('\n'),
    )
    const before = await board()
    const result = applyStudioEditBatch(dir, [exposeClass(before.instances[1]!.children[0]!, { padding: '20px' }, { file: 'components/Tier.module.css' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('components/Tier.module.css')).toBe('.tier {\n  padding: 8px;\n}\n\n.tier:global(.tier-home-2) {\n  padding: 20px;\n}\n')
    expect(read('components/Tier.tsx')).toContain('<section className={`${styles.tier} ${className || \'\'}`}>')
  })
})

// --- spread-forwarding -------------------------------------------------------------------------------------------

const TIER_ACCEPTING = [
  "import './Tier.css'",
  'interface TierProps { name: string; price: number; className?: string }',
  'export function Tier({ name, price, className }: TierProps) {',
  '  return (',
  "    <section className={`tier ${className || ''}`}>",
  '      <h3 className="tier__name">Plan</h3>',
  '      <p className="tier__price">{name}{price}</p>',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')

const PANEL_SPREAD = ["import { Tier } from './Tier'", 'interface PanelProps { name: string; price: number }', 'export function Panel(props: PanelProps) {', '  return <Tier {...props} />', '}', ''].join('\n')

const PANEL_HOME = [
  "import { Panel } from '../components/Panel'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Panel name="Basic" price={5} />',
  '      <Panel name="Plus" price={9} />',
  '      <Panel name="Pro" price={19} />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const PANEL_FILES = ['components/Tier.tsx', 'components/Tier.css', 'components/Panel.tsx', 'pages/Home.tsx']

function spreadProject(panel = PANEL_SPREAD, tier = TIER): void {
  write('components/Tier.tsx', tier)
  write('components/Panel.tsx', panel)
  write('pages/Home.tsx', PANEL_HOME)
}

function byId(b: Board, id: string | undefined): PageNode {
  return b.pages.flatMap((page) => Object.values(page.nodes)).find((node) => node.id === id)!
}

/** The Tier root inside a Panel instance (Panel -> Tier -> root). */
function innerRootOf(b: Board, panel: PageNode): PageNode {
  return byId(b, byId(b, panel.children[0]).children[0])
}

describe('a component that passes its props on with a spread is not edited', () => {
  it("the class travels through the spread: the page's call site passes it, the forwarder gains only the type, the inner root reads it", async () => {
    spreadProject(PANEL_SPREAD, TIER_ACCEPTING)
    const before = await board('Panel')
    expect(before.instances).toHaveLength(3)
    const original = snapshot(PANEL_FILES)
    const result = applyStudioEditBatch(dir, [exposeClass(innerRootOf(before, before.instances[1]!).id, { padding: '20px' })], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toContain('<Panel name="Plus" price={9} className="tier-home-2" />')
    // Tier already took className; Panel's body is untouched, its props type gains the property.
    expect(read('components/Tier.tsx')).toBe(TIER_ACCEPTING)
    expect(read('components/Panel.tsx')).toBe(PANEL_SPREAD.replace('price: number }', 'price: number; className?: string }'))

    const after = await board('Panel')
    const classes = (node: PageNode) => (innerRootOf(after, node).classIds ?? []).map((id) => after.styleRules[id]?.name)
    expect(classes(after.instances[0]!)).toEqual(['tier'])
    expect(classes(after.instances[1]!)).toEqual(['tier', 'tier-home-2'])
    expect(classes(after.instances[2]!)).toEqual(['tier'])

    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(snapshot(PANEL_FILES)).toEqual(original)
  })

  it('a literal travels through the spread too: the page passes it, the inner component declares it, the other instances read the default', async () => {
    spreadProject(PANEL_SPREAD, TIER_ACCEPTING)
    const before = await board('Panel')
    const heading = byId(before, innerRootOf(before, before.instances[1]!).children[0])
    const result = applyStudioEditBatch(dir, [{ kind: 'expose-prop', nodeId: heading.id, overrides: [{ target: { kind: 'text' }, propName: 'heading', value: 'Starter' }] }], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toContain('<Panel name="Plus" price={9} heading="Starter" />')
    expect(read('pages/Home.tsx')).toContain('<Panel name="Basic" price={5} />')
    expect(read('components/Panel.tsx')).toBe(PANEL_SPREAD.replace('price: number }', 'price: number; heading?: string }'))
    expect(read('components/Tier.tsx')).toContain("heading = 'Plan'")
    expect(read('components/Tier.tsx')).toContain('<h3 className="tier__name">{heading}</h3>')

    const after = await board('Panel')
    const texts = after.instances.map((panel) => (byId(after, innerRootOf(after, panel).children[0]).props as { text: string }).text)
    expect(texts).toEqual(['Plan', 'Starter', 'Plan'])
  })

  it('a forwarder that takes className itself, a filtering spread and a hop that passes props one by one are refused by name, writing nothing', async () => {
    const cases: [string, string][] = [
      ['class-filtered', ["import { Tier } from './Tier'", 'interface PanelProps { name: string; price: number; className?: string }', 'export function Panel({ className, ...rest }: PanelProps) {', '  return <Tier {...rest} />', '}', ''].join('\n')],
      ['class-filtered', ["import { Tier } from './Tier'", 'interface PanelProps { name: string; price: number }', 'const omit = (props: PanelProps) => props', 'export function Panel(props: PanelProps) {', '  return <Tier {...omit(props)} />', '}', ''].join('\n')],
      ['class-not-forwarded', ["import { Tier } from './Tier'", 'export function Panel({ name, price }: { name: string; price: number }) {', '  return <Tier name={name} price={price} />', '}', ''].join('\n')],
    ]
    for (const [reason, panel] of cases) {
      spreadProject(panel, TIER_ACCEPTING)
      const before = await board('Panel')
      const files = snapshot(PANEL_FILES)
      const result = applyStudioEditBatch(dir, [exposeClass(innerRootOf(before, before.instances[1]!).id, { padding: '20px' })], {}, EDITOR)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual([reason])
      expect(result.written).toBe(0)
      expect(snapshot(PANEL_FILES)).toEqual(files)
    }
  })

  it('a literal through a filtering spread is refused as a spread it cannot read', async () => {
    spreadProject(["import { Tier } from './Tier'", 'const omit = (props: { name: string; price: number }) => props', 'export function Panel(props: { name: string; price: number }) {', '  return <Tier {...omit(props)} />', '}', ''].join('\n'), TIER_ACCEPTING)
    const before = await board('Panel')
    const heading = byId(before, innerRootOf(before, before.instances[1]!).children[0])
    const files = snapshot(PANEL_FILES)
    const result = applyStudioEditBatch(dir, [{ kind: 'expose-prop', nodeId: heading.id, overrides: [{ target: { kind: 'text' }, propName: 'heading', value: 'Starter' }] }], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['call-site-spread'])
    expect(snapshot(PANEL_FILES)).toEqual(files)
  })
})

describe("what cannot be given one instance's own class is refused by name, writing nothing", () => {
  it("an element inside the component (only the root takes a class), a spread at the page's call site, and another call site that passes a className", async () => {
    const before = await board()
    const inner = byId(before, rootOf(before, before.instances[1]!).children[0])
    let files = snapshot(ALL)
    let result = applyStudioEditBatch(dir, [exposeClass(inner.id, { color: 'red' }, { selector: '.tier__name' })], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['class-not-root'])
    expect(snapshot(ALL)).toEqual(files)

    write('pages/Home.tsx', HOME.replace('<Tier name="Plus" price={9} />', '<Tier name="Plus" price={9} {...extra} />').replace('export default function Home() {', 'const extra = {}\nexport default function Home() {'))
    const spread = await board()
    files = snapshot(ALL)
    result = applyStudioEditBatch(dir, [exposeClass(spread.instances[1]!.children[0]!, { padding: '20px' })], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['call-site-spread'])
    expect(snapshot(ALL)).toEqual(files)

    write('pages/Home.tsx', HOME)
    write('pages/Other.tsx', ["import { Tier } from '../components/Tier'", 'export default function Other() {', '  return <Tier name="Legacy" price={1} className="legacy" />', '}', ''].join('\n'))
    const stray = await board()
    files = snapshot([...ALL, 'pages/Other.tsx'])
    const homeInstance = stray.instances.find((node) => node.id.startsWith('pages/Home.tsx'))!
    result = applyStudioEditBatch(dir, [exposeClass(homeInstance.children[0]!, { padding: '20px' })], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['call-site-class'])
    expect(snapshot([...ALL, 'pages/Other.tsx'])).toEqual(files)
  })

  it('a stylesheet that does not parse and a rule that is not one plain class', async () => {
    const before = await board()
    let result = applyStudioEditBatch(dir, [exposeClass(before.instances[1]!.children[0]!, { padding: '20px' }, { selector: '.tier:hover' })], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['class-selector-unsupported'])
    write('components/Tier.css', '.tier { padding: ')
    const files = snapshot(ALL)
    result = applyStudioEditBatch(dir, [exposeClass(before.instances[1]!.children[0]!, { padding: '20px' })], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['css-syntax'])
    expect(snapshot(ALL)).toEqual(files)
  })

  it('an Apply to all with nothing to apply', async () => {
    const before = await board()
    const result = applyStudioEditBatch(dir, [{ kind: 'promote-class-override', nodeId: before.instances[1]!.children[0]!, file: 'components/Tier.css', selector: '.tier', properties: ['padding'] }], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['not-an-override'])
  })
})
