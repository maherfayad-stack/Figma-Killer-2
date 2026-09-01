/**
 * hardcodedStrings — the scan that makes the Content panel useful on a
 * project with no i18n at all.
 *
 * The filter is the whole design, and the case that forced it is the SVG one:
 * a path's `d` attribute is long, contains spaces and contains letters, so it
 * passes every "looks like a sentence" heuristic there is. Measured on the
 * real `untitled-2` project, 4 of the first 14 hits were path data — each one
 * hundreds of characters — burying the six actual strings on the same screen.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { findHardcodedStrings } from '../../../server/handlers/studio/hardcodedStrings'

let dir: string

function write(rel: string, contents: string): void {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

beforeEach(() => {
  const root = projectsRootDir()
  mkdirSync(root, { recursive: true })
  dir = mkdtempSync(join(root, '__hardcoded_test_'))
  write('package.json', JSON.stringify({ name: 'fixture' }))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('findHardcodedStrings', () => {
  it('finds copy in props and in JSX text, with its source location', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <Banner title="Profile verified" />',
        '      <p>Add your text here.</p>',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['Profile verified', 'Add your text here.'])
    expect(found[0]).toMatchObject({ file: 'pages/Page.tsx', line: 4, prop: 'title' })
    // A JSX text child has no prop — that is what `null` means here.
    expect(found[1]!.prop).toBeNull()
  })

  it('ignores SVG geometry, which defeats every sentence heuristic', () => {
    write(
      'pages/Icon.tsx',
      [
        'export default function Icon() {',
        '  return (',
        '    <svg viewBox="0 0 24 24">',
        '      <path d="M14.5 6.5C14.7761 6.5 15 6.72386 15 7C15 7.27614 14.7761 7.5 14.5 7.5H7.53516Z" />',
        '      <title>A close button icon</title>',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    expect(findHardcodedStrings(dir)).toEqual([])
  })

  it('ignores machinery props and single-token values', () => {
    write(
      'pages/Card.tsx',
      [
        'export default function Card() {',
        '  return <Cell className="row wide" variant="primary" href="/settings" type="success" size="sm" />',
        '}',
        '',
      ].join('\n'),
    )
    expect(findHardcodedStrings(dir)).toEqual([])
  })

  it('ignores a digit-dominated value that is not prose', () => {
    write('pages/Chart.tsx', 'export default function Chart() { return <Poly points="0,0 10,20 30,40 50,60" /> }\n')
    expect(findHardcodedStrings(dir)).toEqual([])
  })

  it('keeps a capitalised single word and drops a lowercase enum token', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <Cell label="From" trailing="chevron" />',
        '      <Cell label="Dates" />',
        '      <Chip tone="muted" caption="solid" />',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // `From`/`Dates` are the shortest and commonest copy on a real screen;
    // `solid` on a non-excluded prop is an enum token, and casing is what
    // separates them.
    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['From', 'Dates'])
  })

  it('reads copy nested inside a prop expression, keyed by its own path', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        "  return <Navbar toolbar={{ variant: 'default', title: 'Account' }} items={['Flights', 'Stays']} />",
        '}',
        '',
      ].join('\n'),
    )

    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['Account', 'Flights', 'Stays'])
    // The nested key is reported as its own path, not as the outer prop alone.
    expect(found[0]!.prop).toBe('toolbar.title')
    expect(found[1]!.prop).toBe('items')
  })

  it('excludes SVG geometry nested inside a prop, not just inside a top-level <svg>', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <Cell',
        '      label="Push notifications"',
        '      icon={<svg viewBox="0 0 24 24"><path d="M14.5 6.5C14.7 6.5 15 6.7 15 7" stroke="currentColor" /></svg>}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['Push notifications'])
  })

  it('ignores a string inside a handler, which is behaviour rather than copy', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        "  return <Button label=\"Continue\" onClick={() => track('Checkout started here')} />",
        '}',
        '',
      ].join('\n'),
    )

    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['Continue'])
  })

  it('reads a string literal in child position — a placeholder typed on the canvas', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <h3>{"asdasdasdas"}</h3>',
        '      <p>{"asdfasdfasdfasd"}</p>',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // Lowercase and single-token, so the PROP-position identifier heuristic
    // would reject both — but in child position there is no prop that could
    // make them machinery, and the user can see them on screen.
    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['asdasdasdas', 'asdfasdfasdfasd'])
    expect(found[0]!.prop).toBeNull()
  })

  it('treats `value` as copy on a component and machinery on a host element', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <Cell label="From" value="Dubai (DXB)" />',
        '      <input value="Dubai (DXB)" />',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // Translating a <Cell>'s value changes what the user reads; translating an
    // <input>'s changes what the form submits.
    const found = findHardcodedStrings(dir)
    expect(found.map((f) => `${f.prop}=${f.text}`)).toEqual(['label=From', 'value=Dubai (DXB)'])
  })

  it('keeps a date, which is digit-heavy but has a real word in it', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <Cell label="Dates" value="11 – 28 Aug" />',
        '      <Chart caption="0 0 24 24" />',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const found = findHardcodedStrings(dir)
    expect(found.map((f) => f.text)).toEqual(['Dates', '11 – 28 Aug'])
  })
})

describe('a TabBar inserted with its icons', () => {
  /**
   * The shape Studio itself writes: five `{ icon: <svg…/>, label: '…' }` items,
   * each icon a full inline SVG document of path data.
   *
   * Two things must hold at once, and they pull in opposite directions. The
   * five LABELS are copy and have to reach the Content panel — a tab bar whose
   * labels cannot be translated is a tab bar that is English forever. The path
   * data around them is geometry and must not: `d="M11.8 3.1L11.5 2.7…"` is not
   * a string anybody translates, and five of them would bury the labels they
   * sit beside.
   */
  const ICON = '<svg viewBox="0 0 24 24"><path d="M11.8281 3.17381L11.5564 2.75411Z" fill="currentColor" /></svg>'
  const tab = (label: string) => `{ icon: ${ICON.replace(/^/, '')}, label: "${label}" }`

  beforeEach(() => {
    write(
      'pages/Home.tsx',
      [
        'export default function Home() {',
        '  return (',
        `    <TabBar items={[${['Home', 'Explore', 'My Trips', 'Top offers', 'Profile'].map(tab).join(', ')}]} value={0} />`,
        '  )',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('offers every tab label for translation', () => {
    const found = findHardcodedStrings(dir).map((s) => s.text)
    expect(found).toContain('Home')
    expect(found).toContain('Explore')
    expect(found).toContain('My Trips')
    expect(found).toContain('Top offers')
    expect(found).toContain('Profile')
  })

  it('offers no SVG path data', () => {
    for (const found of findHardcodedStrings(dir)) {
      expect(found.text).not.toContain('M11.8281')
      expect(found.text).not.toBe('currentColor')
      expect(found.text).not.toBe('0 0 24 24')
    }
  })

  it('names the prop the label sits under, so the panel can group it', () => {
    const home = findHardcodedStrings(dir).find((s) => s.text === 'Home')
    expect(home?.prop).toBe('items.label')
  })
})
