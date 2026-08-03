/**
 * designSystemGuide — turn an installed design-system package's own docs into
 * the two things an agent authoring a screen actually needs, and nothing else:
 *
 *   1. **A decision map** — "I want to show a static property of an item" ->
 *      `Tag`. Small enough to inline directly into the project's generated
 *      `CLAUDE.md`, so it is loaded before the agent's first thought rather
 *      than fetched after its first mistake.
 *   2. **A props index** — every component's real prop signature, one fenced
 *      block each, written to `.claude/design-system-components.md` for the
 *      agent to open when it has picked a component and needs its API.
 *
 * ## Why this exists
 *
 * The observed failure was not that the agent refused to use the design
 * system — it imported `Button` and `TextInput` happily. It was that it did
 * not know what ELSE existed, so a back button became the literal character
 * `‹`, a list of feature rows became four emoji (`✈ 🗓 🏷 ⚡`), and a media
 * slot became a grey `<div role="img">` — in a project whose installed
 * package ships `GlassButton`, `ListItem`, `Cell`, `VisualCard` and a full
 * line-icon set. Every one of those was one import away.
 *
 * Discovering that vocabulary cost a tool call the agent had no reason to
 * make, against a catalog extractor that returns nothing for this package
 * anyway (it reads `.d.ts` declarations; ALM ships bundled untyped JS). The
 * package's own docs, meanwhile, say all of it plainly — they are simply too
 * large to read whole (~103 KB / ~106 KB, past every read cap in the system).
 * So Studio reads them here, ONCE per regeneration, server-side, and keeps
 * the parts that answer "which component" and "what props".
 *
 * Nothing here is ALM-specific: it looks for conventional headings in
 * `design.md`/`CLAUDE.md` at the package root and degrades to `undefined`
 * when a package does not ship them. A design system with no docs simply
 * contributes nothing rather than producing a confidently empty reference.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Package docs are big by nature; this is a sanity ceiling, not a budget — the whole point is that we keep only a fraction of what we read. */
const MAX_DOC_BYTES = 2_000_000

export interface DesignSystemGuide {
  readonly packageName: string
  /** The "I want to… -> use X" table, verbatim. Inlined into `CLAUDE.md`. */
  readonly decisionMap?: string
  /** How to import the package — built from its real name and its own `exports` map, never copied from its docs. */
  readonly importContract?: string
  /** One entry per documented component. */
  readonly components: readonly ComponentApi[]
  /** The icon surface — named React exports, plus the raw SVG catalogs. */
  readonly icons?: IconSurface
}

export interface IconSurface {
  /** Icon components importable BY NAME from the package root, e.g. `ChevronLeftIcon`. */
  readonly components: readonly string[]
  /** Raw SVG catalogs under the package's own icon directory. */
  readonly catalogs: readonly IconCatalog[]
}

export interface IconCatalog {
  /** Project-relative-to-package path, e.g. `src/icons/line-icons`. */
  readonly path: string
  /** Every SVG basename in it, extension dropped. */
  readonly names: readonly string[]
}

export interface ComponentApi {
  readonly name: string
  /** One-sentence intent, from `design.md` where the package ships one. */
  readonly summary?: string
  /** The component's own fenced props example, from `CLAUDE.md`. */
  readonly props?: string
}

interface Section {
  readonly level: number
  readonly title: string
  readonly body: string
}

function readDoc(pkgDir: string, file: string): string | undefined {
  try {
    const text = readFileSync(join(pkgDir, file), 'utf8')
    return text.length > MAX_DOC_BYTES ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Split ATX-heading markdown into flat sections, ignoring headings inside
 * fenced code blocks — a `# comment` line in a shell example is not a
 * heading, and treating it as one silently truncates the section it sits in.
 */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = []
  let current: { level: number; title: string; lines: string[] } | null = null
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (current) sections.push({ level: current.level, title: current.title, body: current.lines.join('\n').trim() })
      current = { level: heading[1]!.length, title: heading[2]!.trim(), lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  if (current) sections.push({ level: current.level, title: current.title, body: current.lines.join('\n').trim() })
  return sections
}

/** The first section whose title matches, case-insensitively, at any level. */
function findSection(sections: readonly Section[], title: string): Section | undefined {
  const wanted = title.toLowerCase()
  return sections.find((s) => s.title.toLowerCase() === wanted)
}

/** The first fenced block in a body, fences included — a component's props example. */
function firstFencedBlock(body: string): string | undefined {
  const match = /^```[a-z]*\n[\s\S]*?\n```$/m.exec(body)
  return match ? match[0] : undefined
}

/**
 * The first real prose line of a section: not a heading, not a fence or its
 * contents, not a table row, not a bullet. That is the sentence a human wrote
 * to say what the component is for, which is exactly the one line worth
 * carrying next to its props.
 */
function firstProseLine(body: string): string | undefined {
  let inFence = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || line.length === 0) continue
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('-') || line.startsWith('*') || line.startsWith('>')) continue
    return line
  }
  return undefined
}

/**
 * Read `<pkgDir>`'s own docs and keep the parts that answer "which component"
 * and "what props". `undefined` when the package ships neither doc — a
 * package with no documentation contributes nothing rather than an empty
 * reference file that reads as "this design system has no components".
 */
export function buildDesignSystemGuide(pkgDir: string, packageName: string): DesignSystemGuide | undefined {
  const apiDoc = readDoc(pkgDir, 'CLAUDE.md')
  const intentDoc = readDoc(pkgDir, 'design.md')
  if (apiDoc === undefined && intentDoc === undefined) return undefined

  const apiSections = apiDoc ? splitSections(apiDoc) : []
  const intentSections = intentDoc ? splitSections(intentDoc) : []

  const decisionMap = findSection(intentSections, 'Component Decision Map')?.body

  // Every `### <Name>` under `## Components`. Flat sections keep their order,
  // so "after the Components heading and before the next `##`" is a slice.
  const componentsAt = apiSections.findIndex((s) => s.level === 2 && s.title.toLowerCase() === 'components')
  const components: ComponentApi[] = []
  if (componentsAt !== -1) {
    for (const section of apiSections.slice(componentsAt + 1)) {
      if (section.level <= 2) break
      if (section.level !== 3) continue
      const intent = intentSections.find((s) => s.level === 2 && s.title === section.title)
      const summary = (intent ? firstProseLine(intent.body) : undefined) ?? firstProseLine(section.body)
      const props = firstFencedBlock(section.body)
      components.push({
        name: section.title,
        ...(summary ? { summary } : {}),
        ...(props ? { props } : {}),
      })
    }
  }

  if (!decisionMap && components.length === 0) return undefined
  const importContract = buildImportContract(pkgDir, packageName, components)
  const icons = buildIconSurface(pkgDir)
  return {
    packageName,
    ...(decisionMap ? { decisionMap } : {}),
    ...(importContract ? { importContract } : {}),
    components,
    ...(icons ? { icons } : {}),
  }
}

/**
 * The package's icon surface — the thing whose absence produced the worst
 * output this generator has caused.
 *
 * The guide told the agent "the package ships a real icon set; import from
 * it" and then named no export, no path, and no file. That is an instruction
 * that cannot be followed, so the agent did the only thing left: it
 * hand-drew SVG path data into a local `icons.tsx` — including
 * `ChevronLeft` and `ChevronDown`, which are literally named exports of this
 * package (`ChevronLeftIcon`, `ChevronDownIcon`). The hand-drawn ones then
 * rendered as specks on the canvas.
 *
 * Two independent surfaces, because they are imported differently and
 * conflating them is its own failure:
 *
 *   - **Named React components** re-exported from the package root
 *     (`import { ChevronLeftIcon } from '<pkg>'`). Read from `src/index.js`'s
 *     own re-export block — the package's own statement of what is public,
 *     rather than from `LineIcons.jsx`, which defines more than it exports.
 *   - **Raw SVG files** under `src/icons/<catalog>/`, reachable through the
 *     package's `./src/icons/*` export. These are ordinary Vite asset
 *     imports, not components.
 *
 * `undefined` for a package with neither, so a design system that ships no
 * icons contributes no icon section rather than an empty one that reads as
 * "there are no icons here".
 */
function buildIconSurface(pkgDir: string): IconSurface | undefined {
  const components = readIconComponentExports(pkgDir)
  const catalogs = readIconCatalogs(pkgDir)
  if (components.length === 0 && catalogs.length === 0) return undefined
  return { components, catalogs }
}

/** Names in `src/index.js`'s `export { … } from './icons/…'` block — the package's own public statement. */
function readIconComponentExports(pkgDir: string): string[] {
  let source: string
  try {
    source = readFileSync(join(pkgDir, 'src', 'index.js'), 'utf8')
  } catch {
    return []
  }
  const names = new Set<string>()
  for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']*icons[^']*)'/g)) {
    for (const raw of block[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && /^[A-Z][A-Za-z0-9]*$/.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

/** Every `src/icons/<dir>/` holding SVGs, with their basenames. */
function readIconCatalogs(pkgDir: string): IconCatalog[] {
  const root = join(pkgDir, 'src', 'icons')
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const catalogs: IconCatalog[] = []
  for (const entry of entries.sort()) {
    let names: string[]
    try {
      if (!statSync(join(root, entry)).isDirectory()) continue
      names = readdirSync(join(root, entry))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => f.replace(/\.svg$/, ''))
        .sort()
    } catch {
      continue
    }
    if (names.length > 0) catalogs.push({ path: `src/icons/${entry}`, names })
  }
  return catalogs
}

/**
 * How to import this package, built from its real installed name and its own
 * `exports` map — deliberately NOT copied out of its docs.
 *
 * The ALM package's own `CLAUDE.md` documents `import { Button } from
 * 'design-system'`: the name it uses in its own monorepo, not the name it
 * publishes under. Embedding that verbatim would have taught the agent an
 * import specifier that resolves to nothing and breaks the build — the exact
 * failure the guide warns about, shipped by the guide itself. The package
 * name Studio knows from the project's dependencies is the true one, so the
 * contract is generated around it.
 *
 * The stylesheet line is only emitted when the package actually exports a
 * `.css` entry; a package that bundles its styles into the JS gets no line
 * rather than an invented one.
 */
function buildImportContract(pkgDir: string, packageName: string, components: readonly ComponentApi[]): string | undefined {
  if (components.length === 0) return undefined
  const cssExport = resolveCssExport(pkgDir)
  const sample = components.slice(0, 8).map((c) => c.name).join(', ')
  const lines = [
    '```jsx',
    `import { ${sample} } from '${packageName}'`,
    ...(cssExport ? [`import '${packageName}${cssExport.replace(/^\./, '')}'  // required once — loads all tokens + component CSS`] : []),
    '```',
    '',
    `\`${packageName}\` is the exact specifier. Import components by name from the package root; never deep-import a component file, and never use any other spelling of the package name.`,
  ]
  return lines.join('\n')
}

/** The package's own `.css` export path, from its `exports` map — `undefined` when it publishes none. */
function resolveCssExport(pkgDir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    const exportsMap = (raw as { exports?: unknown }).exports
    if (!exportsMap || typeof exportsMap !== 'object') return undefined
    return Object.keys(exportsMap as Record<string, unknown>).find((key) => key.endsWith('.css'))
  } catch {
    return undefined
  }
}

/**
 * The `.claude/design-system-icons.md` body — every icon the agent can reach,
 * with the exact import for each kind.
 *
 * Written as a separate file from the component reference because it answers a
 * different question at a different moment ("what draws a chevron" vs "what
 * props does Button take"), and because the raw catalogs are long: listing
 * hundreds of SVG names inside the component reference would bury the props
 * the agent opened that file for.
 */
export function renderIconReference(guide: DesignSystemGuide): string | undefined {
  const icons = guide.icons
  if (!icons) return undefined
  const lines = [
    `# ${guide.packageName} — icons`,
    '',
    'Generated from the installed package on every chat turn. Do not hand-edit.',
    '',
    '**Never hand-draw an SVG path.** Every icon below already exists. A',
    'hand-written `<svg>` is wrong even when it looks close: it will not match',
    'the set\'s stroke weight, grid, or optical sizing, and it does not inherit',
    '`currentColor` the way these do.',
    '',
  ]

  if (icons.components.length > 0) {
    lines.push(
      `## Icon components (${icons.components.length}) — import by name`,
      '',
      '```jsx',
      `import { ${icons.components.slice(0, 4).join(', ')} } from '${guide.packageName}'`,
      '```',
      '',
      'They take `className` and inherit colour from `currentColor`, so size and',
      'colour them from the parent rule rather than with props.',
      '',
      icons.components.map((n) => `\`${n}\``).join(' · '),
      '',
    )
  }

  for (const catalog of icons.catalogs) {
    lines.push(
      `## ${catalog.path} (${catalog.names.length} SVGs)`,
      '',
      '```jsx',
      `import iconUrl from '${guide.packageName}/${catalog.path}/${catalog.names[0]}.svg'`,
      '// …then render it: <img src={iconUrl} alt="" />',
      '```',
      '',
      catalog.names.join(', '),
      '',
    )
  }
  return lines.join('\n')
}

/** The `.claude/design-system-components.md` body — the props index the guide's `CLAUDE.md` points at. */
export function renderComponentReference(guide: DesignSystemGuide): string {
  const lines = [
    `# ${guide.packageName} — component API`,
    '',
    'Generated from the package\'s own docs on every chat turn. Do not hand-edit.',
    '',
    `Every component below is a real named export of \`${guide.packageName}\`. Import it — do not re-implement it, and do not substitute a raw HTML element, an emoji, or a text glyph for one.`,
    '',
  ]
  if (guide.importContract) {
    lines.push('## Importing', '', guide.importContract, '')
  }
  lines.push(`## Components (${guide.components.length})`, '')
  for (const component of guide.components) {
    lines.push(`### ${component.name}`, '')
    if (component.summary) lines.push(component.summary, '')
    if (component.props) lines.push(component.props, '')
  }
  return lines.join('\n')
}
