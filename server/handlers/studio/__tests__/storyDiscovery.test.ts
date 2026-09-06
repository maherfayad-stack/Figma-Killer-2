/**
 * storyDiscovery / storyPages — W5-3's accepted subset, pinned.
 *
 * Every test here is a shape a REAL Storybook repo writes, not a shape this
 * codebase invented: the CSF3 object with `args`, the `render: args => <X/>`
 * forwarder, the bare `export const Default = () => <X/>`, the
 * `export function Default()` declaration Shopify Polaris uses throughout, and
 * the four things Storybook can only produce by RUNNING code (`play`,
 * `decorators`, `loaders`, a body with statements in it). The last group is the
 * point of the feature's honesty contract — each must refuse with its own
 * NAME, never half-render.
 *
 * The fixtures share nothing with the eSIM corpus on purpose, following
 * `genericRepoShapes.test.ts`'s discipline: a suite grown from one repo encodes
 * that repo's habits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject } from '@core/page-parser'
import { cachedRouteDependencies, clearPageParseCache } from '../pageParseCache'
import { discoverStories, storyFilesIn, type StoryRefusalReason } from '../storyDiscovery'
import { buildStoryRouteEntries, STORY_CALL_SITE_LOCK_REASON, storyPageIdFromRoutePath } from '../storyPages'

/** Stands in for `loadStudioPages`' real workspace-config hash — these tests vary files, never framework/locale/class maps. */
const CONFIG_HASH = 'story-tests'

let tmpDir: string

beforeEach(() => {
  clearPageParseCache()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-discovery-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearPageParseCache()
})

/** Writes `<tmpDir>/<relPath>`, creating parents. */
function write(relPath: string, contents: string): void {
  const file = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/** The `Chip` component every fixture below tells a story about. */
function writeChipComponent(): void {
  write(
    'src/Chip.tsx',
    `export function Chip({ label, tone }: { label: string; tone?: string }) {
  return <span className={\`chip chip--\${tone}\`}>{label}</span>
}
`,
  )
}

function discover() {
  return discoverStories(tmpDir, createWorkspaceProject(tmpDir))
}

/** Every refusal reason recorded for `story`, so an assertion names the reason rather than a count. */
function reasonsFor(refusals: ReadonlyArray<{ story?: string; reason: StoryRefusalReason }>, story: string): StoryRefusalReason[] {
  return refusals.filter((refusal) => refusal.story === story).map((refusal) => refusal.reason)
}

describe('storyFilesIn', () => {
  it('finds .stories.tsx/.ts/.jsx and nothing else, excluding node_modules', () => {
    write('src/Chip.stories.tsx', 'export default {}\n')
    write('src/helpers.stories.ts', 'export default {}\n')
    write('src/Legacy.stories.jsx', 'export default {}\n')
    write('src/Chip.tsx', 'export function Chip() { return <span /> }\n')
    write('src/Chip.test.tsx', 'it("x", () => {})\n')
    write('node_modules/pkg/Thing.stories.tsx', 'export default {}\n')

    expect(storyFilesIn(tmpDir)).toEqual([
      'src/Chip.stories.tsx',
      'src/Legacy.stories.jsx',
      'src/helpers.stories.ts',
    ])
  })

  it('returns nothing for a project with no stories — the zero-cost gate', () => {
    write('pages/Home.tsx', 'export default function Home() { return <div /> }\n')
    expect(storyFilesIn(tmpDir)).toEqual([])
  })
})

describe('discoverStories — the accepted subset', () => {
  it('reads a CSF3 args-only story, merging meta.args under the story\'s own', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import type { Meta, StoryObj } from '@storybook/react'
import { Chip } from './Chip'

const meta: Meta<typeof Chip> = {
  title: 'Data/Chip',
  component: Chip,
  args: { label: 'Base', tone: 'neutral' },
}
export default meta
type Story = StoryObj<typeof Chip>

export const Critical: Story = {
  args: { tone: 'critical' },
}
`,
    )

    const { stories, refusals } = discover()
    expect(refusals).toEqual([])
    expect(stories).toHaveLength(1)
    const [story] = stories
    expect(story!.summary.title).toBe('Data/Chip')
    expect(story!.summary.frameTitle).toBe('Data/Chip / Critical')
    expect(story!.body.kind).toBe('args')
    if (story!.body.kind !== 'args') throw new Error('expected an args body')
    // The story's own arg wins; meta's survives where the story is silent.
    expect(story!.body.args).toEqual({ label: 'Base', tone: 'critical' })
    expect(story!.body.componentSource).toEqual({ kind: 'local', file: 'src/Chip.tsx' })
  })

  it('reads `export default { … } satisfies Meta<…>` and a story `name` override', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'

export default { title: 'Data/Chip', component: Chip } satisfies { title: string; component: unknown }

export const Primary = { name: 'The primary one', args: { label: 'Go' } }
`,
    )

    const { stories, refusals } = discover()
    expect(refusals).toEqual([])
    expect(stories.map((s) => s.summary.frameTitle)).toEqual(['Data/Chip / The primary one'])
  })

  it('accepts a `render` that is nothing but JSX, with no meta.component at all', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'

export default { title: 'Data/Chip' }

export const Playground = {
  render: (args: { label: string }) => <Chip {...args} />,
}
`,
    )

    const { stories, refusals } = discover()
    expect(refusals).toEqual([])
    expect(stories).toHaveLength(1)
    expect(stories[0]!.body.kind).toBe('jsx')
  })

  it('accepts a bare arrow export and an exported function declaration', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'

export default { title: 'Data/Chip' }

export const Arrow = () => <Chip label="arrow" />

export function Declared() {
  return <Chip label="declared" />
}
`,
    )

    const { stories, refusals } = discover()
    expect(refusals).toEqual([])
    expect(stories.map((s) => s.summary.exportName).sort()).toEqual(['Arrow', 'Declared'])
    expect(stories.every((s) => s.body.kind === 'jsx')).toBe(true)
  })

  it('drops an arg whose value is not a literal, and keeps its siblings', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const WithHandler = {
  args: { label: 'Save', onPress: () => {}, count: -2, nested: { deep: true }, list: ['a', 'b'] },
}
`,
    )

    const { stories } = discover()
    const body = stories[0]!.body
    if (body.kind !== 'args') throw new Error('expected an args body')
    // `onPress` is dropped, never stubbed — there is no JSON form for it.
    expect(body.args).toEqual({ label: 'Save', count: -2, nested: { deep: true }, list: ['a', 'b'] })
  })

  it('assigns a unique, file-anchored page id per story', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const Primary = { args: { label: 'a' } }
export const Secondary = { args: { label: 'b' } }
`,
    )

    const { stories } = discover()
    expect(stories.map((s) => s.summary.pageId)).toEqual([
      'src-chip-stories-primary',
      'src-chip-stories-secondary',
    ])
  })
})

describe('discoverStories — the named refusals', () => {
  beforeEach(() => {
    writeChipComponent()
  })

  it('refuses the whole file for CSF2 storiesOf', () => {
    write(
      'src/Chip.stories.tsx',
      `import { storiesOf } from '@storybook/react'
import { Chip } from './Chip'
storiesOf('Data/Chip', module).add('primary', () => <Chip label="x" />)
`,
    )
    const { stories, refusals } = discover()
    expect(stories).toEqual([])
    expect(refusals.map((r) => r.reason)).toEqual(['csf2-storiesof'])
    expect(refusals[0]!.story).toBeUndefined()
  })

  it('refuses the whole file when the meta declares decorators', () => {
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip, decorators: [(S: () => unknown) => S()] }
export const Primary = { args: { label: 'x' } }
`,
    )
    const { stories, refusals } = discover()
    expect(stories).toEqual([])
    expect(refusals.map((r) => r.reason)).toEqual(['decorators'])
  })

  it('refuses per story: play, loaders, a body with statements, and a non-story export', () => {
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }

export const Interactive = { args: { label: 'x' }, play: async () => {} }
export const Loaded = { args: { label: 'x' }, loaders: [async () => ({})] }
export const Stateful = {
  render: () => {
    const tone = 'critical'
    return <Chip label="x" tone={tone} />
  },
}
export const NotAStory = 'just a string'
`,
    )
    const { stories, refusals } = discover()
    expect(stories).toEqual([])
    expect(reasonsFor(refusals, 'Interactive')).toEqual(['play-function'])
    expect(reasonsFor(refusals, 'Loaded')).toEqual(['loaders'])
    expect(reasonsFor(refusals, 'Stateful')).toEqual(['render-logic'])
    expect(reasonsFor(refusals, 'NotAStory')).toEqual(['not-a-story'])
  })

  it('refuses an args-only story whose meta names no component', () => {
    write(
      'src/Chip.stories.tsx',
      `export default { title: 'Data/Chip' }
export const Primary = { args: { label: 'x' } }
`,
    )
    expect(reasonsFor(discover().refusals, 'Primary')).toEqual(['no-component'])
  })

  it('refuses spread args — the resulting keys are unknowable without evaluating them', () => {
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const Primary = { args: { label: 'x' } }
export const Secondary = { args: { ...Primary.args, tone: 'critical' } }
`,
    )
    const { stories, refusals } = discover()
    expect(stories.map((s) => s.summary.exportName)).toEqual(['Primary'])
    expect(reasonsFor(refusals, 'Secondary')).toEqual(['spread-args'])
  })

  it('refuses a story whose component identifier is neither imported nor declared', () => {
    write(
      'src/Chip.stories.tsx',
      `export default { title: 'Data/Chip', component: Mystery }
export const Primary = { args: { label: 'x' } }
`,
    )
    expect(reasonsFor(discover().refusals, 'Primary')).toEqual(['unresolved-component'])
  })

  it('refuses a file with no default export at all', () => {
    write('src/Chip.stories.tsx', "export const Primary = { args: { label: 'x' } }\n")
    const { refusals } = discover()
    expect(refusals.map((r) => r.reason)).toEqual(['no-default-export'])
  })
})

describe('buildStoryRouteEntries', () => {
  it('inlines an args-only story into the component\'s real subtree, and refuses to write its args', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const Critical = { args: { label: 'Danger', tone: 'critical' } }
`,
    )

    const project = createWorkspaceProject(tmpDir)
    const { stories } = discoverStories(tmpDir, project)
    const entries = buildStoryRouteEntries(tmpDir, project, stories, undefined, undefined, CONFIG_HASH)

    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.pageId).toBe('src-chip-stories-critical')
    expect(entry.title).toBe('Data/Chip / Critical')
    expect(entry.relFile).toBe('src/Chip.stories.tsx')

    // The synthesized call site anchors at a REAL position in the story file.
    const callSiteId = entry.expanded.rootIds[0]!
    expect(callSiteId).toMatch(/^src\/Chip\.stories\.tsx:\d+:\d+$/)

    const callSite = entry.expanded.nodes[callSiteId]!
    // Inlining turned it into an instance carrying the component's own subtree.
    expect(callSite.instanceOf?.componentName).toBe('Chip')
    expect(callSite.instanceOf?.sourceFile).toBe('src/Chip.tsx')
    expect(callSite.children).toHaveLength(1)

    // No JSX lives at the call site's position, so every arg is code-valued.
    expect(callSite.locked).toBe(true)
    expect(callSite.lockReason).toBe(STORY_CALL_SITE_LOCK_REASON)
    expect([...(callSite.codeProps ?? [])].sort()).toEqual(['label', 'tone'])
    // Deliberately NO `origin` — see `storyPages.ts`'s header for the blocker.
    expect(callSite.resolvedProps?.label).toEqual({
      source: 'args.label',
      note: 'Storybook story "Critical"',
    })

    // The args reached the component's own JSX through the real substituter.
    const inlined = entry.expanded.nodes[callSite.children[0]!]!
    expect(inlined.text).toBe('Danger')
    expect(inlined.loc.file).toBe('src/Chip.tsx')
  })

  it('gives a jsx-only story real, writable ids in the story file itself', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip' }
export const Declared = () => <Chip label="declared" />
`,
    )

    const project = createWorkspaceProject(tmpDir)
    const { stories } = discoverStories(tmpDir, project)
    const entries = buildStoryRouteEntries(tmpDir, project, stories, undefined, undefined, CONFIG_HASH)

    const entry = entries[0]!
    const rootId = entry.expanded.rootIds[0]!
    expect(rootId).toMatch(/^src\/Chip\.stories\.tsx:\d+:\d+$/)
    const root = entry.expanded.nodes[rootId]!
    // A jsx-only story is an ordinary parsed call site: unlocked, and its
    // literal props are ordinary writable JSX attributes.
    expect(root.locked).toBe(false)
    expect(root.instanceOf?.componentName).toBe('Chip')
    expect(root.codeProps ?? []).toEqual([])
  })

  it('records the story file AND the components it renders as parse-cache dependencies', () => {
    // What `reloadScope.ts` inverts. Without it a story route claimed nothing,
    // and every save in a Storybook project had to widen to a full reload.
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const Critical = { args: { label: 'Danger' } }
`,
    )

    const project = createWorkspaceProject(tmpDir)
    const { stories } = discoverStories(tmpDir, project)
    const entries = buildStoryRouteEntries(tmpDir, project, stories, undefined, undefined, CONFIG_HASH)

    const deps = cachedRouteDependencies(tmpDir)!
    const routePath = [...deps.keys()].find((key) => storyPageIdFromRoutePath(key) === entries[0]!.pageId)!
    expect(routePath).toBeDefined()
    expect([...deps.get(routePath)!].sort()).toEqual(
      [path.join(tmpDir, 'src', 'Chip.stories.tsx'), path.join(tmpDir, 'src', 'Chip.tsx')].sort(),
    )
  })

  it('reuses a cached story parse until one of those dependencies changes', () => {
    writeChipComponent()
    write(
      'src/Chip.stories.tsx',
      `import { Chip } from './Chip'
export default { title: 'Data/Chip', component: Chip }
export const Critical = { args: { label: 'Before' } }
`,
    )

    const build = () => {
      const project = createWorkspaceProject(tmpDir)
      const { stories } = discoverStories(tmpDir, project)
      return buildStoryRouteEntries(tmpDir, project, stories, undefined, undefined, CONFIG_HASH)[0]!
    }
    const first = build()
    expect(build().expanded).toBe(first.expanded) // same object — the cache answered

    write(
      'src/Chip.tsx',
      `export function Chip({ label }: { label: string }) {
  return <b>{label}</b>
}
`,
    )
    // The cache compares mtimes, and a rewrite inside the same millisecond
    // can land on the identical one — stamp it forward so this asserts the
    // invalidation rule rather than the filesystem's clock resolution.
    const chipFile = path.join(tmpDir, 'src', 'Chip.tsx')
    const future = new Date(Date.now() + 2_000)
    fs.utimesSync(chipFile, future, future)

    const afterComponentEdit = build()
    expect(afterComponentEdit.expanded).not.toBe(first.expanded)
  })
})
