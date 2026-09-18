/**
 * A CRLF checkout parses to exactly the same page tree as its LF twin.
 *
 * Studio opens other people's repositories, and on Windows Git's default
 * `core.autocrlf=true` produces a CRLF working tree. Whether a user's clone
 * happened to be CRLF or LF must not decide what the board shows: not a node
 * id, not a `line:col`, not a resolved value.
 *
 * Two facts make that true, and both are tested here rather than assumed:
 *
 *  1. TypeScript's line/column math already treats `\r\n` as ONE terminator
 *     and the `\r` sits after every token on its line, so `line:col` — the
 *     node-id grammar in `docs/agent-refs/studio-pipeline.md` — is identical
 *     in both forms.
 *  2. `EolPreservingFileSystem` (`../eolFileSystem.ts`) hands ts-morph
 *     LF-only text, so no `\r` can reach a resolved VALUE either — a
 *     multi-line template literal or a multi-line JSX text block would
 *     otherwise carry `\r` into the tree on one platform and not the other.
 *
 * THE FIXTURE SHARES NOTHING WITH THE eSIM CORPUS — it is a lending-library
 * catalogue: named exports, a props interface, a typed data module, a `.map`
 * over it, a multi-line template literal. `genericRepoShapes.test.ts` explains
 * why that discipline matters.
 *
 * The bytes are written by the test, never committed: this repo's own working
 * tree is CRLF-converted on checkout, so a committed CRLF fixture cannot be
 * trusted to still be CRLF.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ParsedPage,
} from '../index'

const FILES: Record<string, string[]> = {
  'catalogue/data/shelves.ts': [
    'export interface Shelf {',
    '  code: string',
    '  label: string',
    '}',
    '',
    'export const SHELVES: Shelf[] = [',
    "  { code: 'A', label: 'Reference' },",
    "  { code: 'B', label: 'Fiction' },",
    ']',
    '',
  ],
  'catalogue/components/ShelfRow.tsx': [
    'export interface ShelfRowProps {',
    '  code: string',
    '  label: string',
    '}',
    '',
    'export function ShelfRow({ code, label }: ShelfRowProps) {',
    '  return (',
    '    <li className="shelf-row">',
    '      <span className="shelf-row__code">{code}</span>',
    '      <span className="shelf-row__label">{label}</span>',
    '    </li>',
    '  )',
    '}',
    '',
  ],
  'catalogue/pages/Catalogue.tsx': [
    "import { SHELVES } from '../data/shelves'",
    "import { ShelfRow } from '../components/ShelfRow'",
    '',
    'const BRANCH = {',
    "  name: 'Riverside',",
    "  hours: 'Open 09:00 to 17:00',",
    '}',
    '',
    'export function Catalogue() {',
    '  const heading = `${BRANCH.name} catalogue`',
    '  return (',
    '    <main className="catalogue">',
    '      <h1 className="catalogue__heading">{heading}</h1>',
    '      <p className="catalogue__hours">{BRANCH.hours}</p>',
    '      <ul className="catalogue__shelves">',
    '        {SHELVES.map((shelf) => (',
    '          <ShelfRow key={shelf.code} code={shelf.code} label={shelf.label} />',
    '        ))}',
    '      </ul>',
    '    </main>',
    '  )',
    '}',
    '',
  ],
}

let lfRoot: string
let crlfRoot: string

function writeWorkspace(root: string, eol: '\n' | '\r\n'): void {
  for (const [rel, lines] of Object.entries(FILES)) {
    const full = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, lines.join(eol), 'utf8')
  }
}

beforeEach(() => {
  lfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-parse-lf-'))
  crlfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-parse-crlf-'))
  writeWorkspace(lfRoot, '\n')
  writeWorkspace(crlfRoot, '\r\n')
})

afterEach(() => {
  fs.rmSync(lfRoot, { recursive: true, force: true })
  fs.rmSync(crlfRoot, { recursive: true, force: true })
})

/** The whole parse a workspace load runs for one page: parse, classify, inline. */
function load(root: string): ParsedPage {
  const file = path.join(root, 'catalogue', 'pages', 'Catalogue.tsx')
  const project = createWorkspaceProject(root)
  const options = { pageBudget: createPageEvalBudget(), workspaceRoot: root }
  const parsed = parsePageFile(file, root, project, options)
  const sources = resolveComponentSources(project, file, root, parsed)
  return inlineLocalComponents(parsed, sources, project, root, { evalOptions: options })
}

describe('a CRLF workspace and its LF twin', () => {
  it('produce the identical page tree — ids, positions, props, text', () => {
    expect(load(crlfRoot)).toEqual(load(lfRoot))
  })

  it('agree on every node id, including the .map row suffixes and the inlined ones', () => {
    const ids = (page: ParsedPage): string[] => Object.keys(page.nodes).sort()
    const crlfIds = ids(load(crlfRoot))
    expect(crlfIds).toEqual(ids(load(lfRoot)))
    expect(crlfIds.some((id) => id.includes('#'))).toBe(true)
    expect(crlfIds.some((id) => id.includes('~'))).toBe(true)
  })

  it('carries no \\r into any resolved value, prop or text', () => {
    const serialised = JSON.stringify(load(crlfRoot))
    expect(serialised).not.toContain('\\r')
  })

  it('resolves the template-literal heading identically on both', () => {
    const headingText = (page: ParsedPage): string | undefined =>
      Object.values(page.nodes).find((node) => node.props.className === 'catalogue__heading')?.text
    expect(headingText(load(crlfRoot))).toBe('Riverside catalogue')
    expect(headingText(load(crlfRoot))).toBe(headingText(load(lfRoot)))
  })

  it('puts every node at the same 1-based line:col in both — the \\r never shifts a column', () => {
    const locations = (page: ParsedPage): string[] =>
      Object.values(page.nodes)
        .map((node) => `${node.loc.file}:${node.loc.line}:${node.loc.col}`)
        .sort()
    expect(locations(load(crlfRoot))).toEqual(locations(load(lfRoot)))
  })
})
