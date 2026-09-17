/**
 * The vendored design system's own documentation, sliced into the pieces the
 * manifest needs.
 *
 * This replaces the `mcp/catalog.js` module the npm used to ship: the same
 * three source-of-truth files (`src/index.js`, `CLAUDE.md`, `design.md`), the
 * same slicing rules, read from `vendor/alm-design-system/` instead of from
 * `node_modules`. The package's `mcp/` folder is deliberately NOT vendored —
 * it depends on `zod`, which is banned repo-wide — so its one useful export
 * lives here now.
 *
 * One behaviour is new, and it is the reason this is not a straight copy: the
 * upstream slicer matched a heading only when its title equalled the component
 * name (or started with `"<name> "`). Three of the 39 components are documented
 * under a heading that spells their name differently — `## List / ListItem`,
 * `## System Banner`, `## Marketing Card` — so those three silently had no
 * intent doc at all. {@link findComponentHeading} matches them, and the heading
 * title is also carried out as a search alias (DS-6).
 */

/** A markdown heading, with the line it sits on. */
interface Heading {
  level: number
  title: string
  line: number
}

/** All headings in a markdown document, ignoring anything inside a fenced code block. */
function headingsOf(markdown: string): { lines: string[]; headings: Heading[] } {
  const lines = markdown.split('\n')
  const headings: Heading[] = []
  let inFence = false
  lines.forEach((line, index) => {
    if (/^```/.test(line)) inFence = !inFence
    if (inFence) return
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) headings.push({ level: match[1]!.length, title: match[2]!.trim(), line: index })
  })
  return { lines, headings }
}

/** The text from a heading up to the next heading of the same or shallower level. */
function sliceAt(lines: string[], headings: Heading[], index: number): string {
  let end = lines.length
  for (let i = index + 1; i < headings.length; i += 1) {
    if (headings[i]!.level <= headings[index]!.level) {
      end = headings[i]!.line
      break
    }
  }
  return lines.slice(headings[index]!.line, end).join('\n').trim()
}

/** `"System Banner"` → `"systembanner"`; `"Marketing Card"` → `"marketingcard"`. */
function collapse(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The heading that documents `name`, at `level`.
 *
 * Matches the collapsed whole title (`System Banner` → `SystemBanner`) or any
 * slash-separated part of it (`List / ListItem` → `ListItem`). Returns the
 * heading itself, not just its body, because the TITLE is a search alias the
 * component's own name does not carry.
 */
function findComponentHeading(headings: Heading[], name: string, level: number): Heading | null {
  const target = collapse(name)
  for (const heading of headings) {
    if (heading.level !== level) continue
    if (collapse(heading.title) === target) return heading
    if (heading.title.split('/').some((part) => collapse(part) === target)) return heading
  }
  return null
}

/**
 * The vendored design system's docs, indexed once.
 *
 * `componentNames` is read from `src/index.js` — the public entry point is the
 * canonical list of what the package exports, and a component with no export
 * is not a component a user can import.
 */
export class VendorDocs {
  private readonly claudeMd: { lines: string[]; headings: Heading[] }
  private readonly designMd: { lines: string[]; headings: Heading[] }

  /** Public component names, sorted — every `export { X } from './components/…'` in `src/index.js`. */
  readonly componentNames: string[]

  constructor(indexJs: string, claudeMd: string, designMd: string) {
    this.claudeMd = headingsOf(claudeMd)
    this.designMd = headingsOf(designMd)
    const names: string[] = []
    const exportRe = /export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*'\.\/components\//g
    let match: RegExpExecArray | null
    while ((match = exportRe.exec(indexJs)) !== null) names.push(match[1]!)
    this.componentNames = names.sort()
  }

  /** The component's API section in `CLAUDE.md` (a `###` heading), or `null`. */
  apiDoc(name: string): string | null {
    const heading = findComponentHeading(this.claudeMd.headings, name, 3)
    if (!heading) return null
    return sliceAt(this.claudeMd.lines, this.claudeMd.headings, this.claudeMd.headings.indexOf(heading))
  }

  /** The component's intent section in `design.md` (a `##` heading), or `null`. */
  intentDoc(name: string): string | null {
    const heading = findComponentHeading(this.designMd.headings, name, 2)
    if (!heading) return null
    return sliceAt(this.designMd.lines, this.designMd.headings, this.designMd.headings.indexOf(heading))
  }

  /** The component's `design.md` heading title — `"List / ListItem"` for `ListItem`. */
  intentHeadingTitle(name: string): string | null {
    return findComponentHeading(this.designMd.headings, name, 2)?.title ?? null
  }

  /** The cross-component "which one do I use" table in `design.md`, or `''`. */
  decisionMap(): string {
    const index = this.designMd.headings.findIndex(
      (heading) => heading.level === 2 && heading.title === 'Component Decision Map',
    )
    if (index === -1) return ''
    return sliceAt(this.designMd.lines, this.designMd.headings, index)
  }

  /**
   * Prop NAMES for a component, pulled out of the first fenced code block in
   * its API doc — the JSX usage example is the most reliable list of real
   * props this package publishes.
   */
  propsFor(name: string): string[] | null {
    const doc = this.apiDoc(name)
    if (!doc) return null
    const block = /```[a-z]*\n([\s\S]*?)```/i.exec(doc)
    if (!block) return []
    const props = new Set<string>()
    const propRe = /(?:^|\s)([a-zA-Z][a-zA-Z0-9]*)=(?:"|'|\{)/g
    let match: RegExpExecArray | null
    while ((match = propRe.exec(block[1]!)) !== null) props.add(match[1]!)
    return [...props].sort()
  }
}
