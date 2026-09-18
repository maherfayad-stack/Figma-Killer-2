/**
 * `transplantJsxElement` — D2 G3's cross-FILE move, held to the same bar
 * `structuralJsxCodemods.test.ts` and `copyJsxCodemods.test.ts` set: assert
 * BOTH whole files, byte for byte, against the originals with one element
 * relocated and whatever imports it needed carried with it.
 *
 * Two files means two ways to be wrong, and both are asserted every time. A
 * refusal must leave BOTH files untouched — the "both writes or neither"
 * guarantee this codemod's own doc makes is worth nothing if only the happy
 * path is checked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transplantJsxElement } from '../transplantJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-transplant-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/** The comment and the blank line exist so the byte-exact assertions protect something real. */
const HOME = `import { Badge } from './ui/Badge'
import Logo from './ui/Logo'

export default function Home() {
  return (
    <main className="home">
      {/* keep me exactly where I am */}
      <h1>Home</h1>

      <Badge tone="quiet">New</Badge>
      <Logo />
    </main>
  )
}
`

const ABOUT = `export default function About() {
  return (
    <main className="about">
      <h1>About</h1>
    </main>
  )
}
`

describe('transplantJsxElement — moving an element between files', () => {
  it('moves the element out of one file and into a container in another, carrying its named import', () => {
    const home = writeFixture('Home.tsx', HOME)
    const about = writeFixture('About.tsx', ABOUT)
    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    // `store-13` — `created` is the element's tag-name position in the
    // DESTINATION file, which is what lets the board select it after the
    // resync instead of leaving the selection on the frame it left.
    expect(result).toMatchObject({ ok: true, carriedImports: ['Badge'] })
    // Line 6 of the destination BELOW, column 8 — the `B` of `<Badge`, the
    // tag-name identifier `locateJsxElement.ts` mints every node id from.
    expect(result.ok && result.created).toEqual({ line: 6, col: 8 })
    expect(fs.readFileSync(home, 'utf8')).toBe(`import { Badge } from './ui/Badge'
import Logo from './ui/Logo'

export default function Home() {
  return (
    <main className="home">
      {/* keep me exactly where I am */}
      <h1>Home</h1>

      <Logo />
    </main>
  )
}
`)
    expect(fs.readFileSync(about, 'utf8')).toBe(`import { Badge } from './ui/Badge'
export default function About() {
  return (
    <main className="about">
      <h1>About</h1>
      <Badge tone="quiet">New</Badge>
    </main>
  )
}
`)
  })

  it('carries a DEFAULT import as a default import, never re-spelled as a named one', () => {
    const home = writeFixture('Home.tsx', HOME)
    const about = writeFixture('About.tsx', ABOUT)
    const logo = locateTag(HOME, 'Logo')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: logo.line,
      col: logo.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(about, 'utf8')).toContain("import Logo from './ui/Logo'")
    expect(fs.readFileSync(about, 'utf8')).not.toContain('{ Logo }')
  })

  it('re-resolves a relative specifier against the destination file own directory', () => {
    const home = writeFixture('pages/Home.tsx', `import { Badge } from '../ui/Badge'

export default function Home() {
  return (
    <main>
      <Badge>New</Badge>
    </main>
  )
}
`)
    const about = writeFixture('pages/deep/About.tsx', ABOUT)
    const source = fs.readFileSync(home, 'utf8')
    const badge = locateTag(source, 'Badge')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(about, 'utf8')).toContain("import { Badge } from '../../ui/Badge'")
  })

  it('lands beside an anchor when one is given', () => {
    const home = writeFixture('Home.tsx', HOME)
    const about = writeFixture('About.tsx', ABOUT)
    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(ABOUT, 'main')
    const heading = locateTag(ABOUT, 'h1')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
      anchorLine: heading.line,
      anchorCol: heading.col,
      position: 'before',
    })

    expect(result.ok).toBe(true)
    const written = fs.readFileSync(about, 'utf8')
    expect(written.indexOf('<Badge')).toBeLessThan(written.indexOf('<h1>'))
  })

  it('copy leaves the origin file byte-identical', () => {
    const home = writeFixture('Home.tsx', HOME)
    const about = writeFixture('About.tsx', ABOUT)
    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
      copy: true,
    })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(home, 'utf8')).toBe(HOME)
    expect(fs.readFileSync(about, 'utf8')).toContain('<Badge tone="quiet">New</Badge>')
  })

  it('carries a helper the origin file EXPORTS, imported FROM the origin', () => {
    const home = writeFixture('Home.tsx', `export const label = 'Hi'

export default function Home() {
  return (
    <main>
      <p title={label}>x</p>
    </main>
  )
}
`)
    const about = writeFixture('About.tsx', ABOUT)
    const source = fs.readFileSync(home, 'utf8')
    const paragraph = locateTag(source, 'p')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: paragraph.line,
      col: paragraph.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result).toMatchObject({ ok: true, carriedImports: ['label'] })
    expect(fs.readFileSync(about, 'utf8')).toContain("import { label } from './Home'")
  })

})

describe('transplantJsxElement — refusals leave BOTH files untouched', () => {
  function expectUntouched(home: string, homeText: string, about: string, aboutText: string): void {
    expect(fs.readFileSync(home, 'utf8')).toBe(homeText)
    expect(fs.readFileSync(about, 'utf8')).toBe(aboutText)
  }

  /**
   * `sec-17`. The same helper as the test above, NOT exported. Writing the
   * move anyway is what this used to do, on the reasoning that "the compiler
   * says so loudly" — but by the time the compiler says anything both files
   * are already written: the markup is gone from the origin, the destination
   * imports a name that is not there, the repository does not build, and ⌘Z
   * undoes none of it (this edit family mints no history entry at all). A
   * write that cannot land honestly in BOTH files refuses, and names the
   * one-line remedy.
   */
  it('refuses a helper the origin declares but does not export, touching neither file', () => {
    const homeText = `const label = 'Hi'

export default function Home() {
  return (
    <main>
      <p title={label}>x</p>
    </main>
  )
}
`
    const home = writeFixture('Home.tsx', homeText)
    const about = writeFixture('About.tsx', ABOUT)
    const paragraph = locateTag(homeText, 'p')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: paragraph.line,
      col: paragraph.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unexported-binding')
    expect(result.refusal.message).toContain('label')
    expectUntouched(home, homeText, about, ABOUT)
  })

  it('refuses an unexported local COMPONENT the destination could never import', () => {
    const homeText = `function Card() {
  return <div className="card" />
}

export default function Home() {
  return (
    <main>
      <Card />
    </main>
  )
}
`
    const home = writeFixture('Home.tsx', homeText)
    const about = writeFixture('About.tsx', ABOUT)
    const card = locateTag(homeText, 'Card')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: card.line,
      col: card.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unexported-binding')
    expect(result.refusal.message).toContain('Card')
    expectUntouched(home, homeText, about, ABOUT)
  })

  it('refuses captured-scope when the element reads a body-local binding, and names it', () => {
    const homeText = `export default function Home({ user }: { user: { name: string } }) {
  return (
    <main>
      <p>{user.name}</p>
    </main>
  )
}
`
    const home = writeFixture('Home.tsx', homeText)
    const about = writeFixture('About.tsx', ABOUT)
    const paragraph = locateTag(homeText, 'p')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: paragraph.line,
      col: paragraph.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('captured-scope')
    expect(result.refusal.message).toContain('`user`')
    expectUntouched(home, homeText, about, ABOUT)
  })

  it('refuses a `.map` row as an expression child', () => {
    const homeText = `export default function Home({ items }: { items: string[] }) {
  return (
    <main>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </main>
  )
}
`
    const home = writeFixture('Home.tsx', homeText)
    const about = writeFixture('About.tsx', ABOUT)
    const row = locateTag(homeText, 'li')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: row.line,
      col: row.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('expression-child')
    expectUntouched(home, homeText, about, ABOUT)
  })

  it('refuses binding-conflict when the destination already means something else by that name', () => {
    const home = writeFixture('Home.tsx', HOME)
    const aboutText = `function Badge() {
  return <span>local</span>
}

export default function About() {
  return (
    <main className="about">
      <h1>About</h1>
    </main>
  )
}
`
    const about = writeFixture('About.tsx', aboutText)
    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(aboutText, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('binding-conflict')
    expectUntouched(home, HOME, about, aboutText)
  })

  it('refuses same-file — that is an ordinary reparent', () => {
    const home = writeFixture('Home.tsx', HOME)
    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(HOME, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: home,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('same-file')
    expect(fs.readFileSync(home, 'utf8')).toBe(HOME)
  })

  it('refuses not-found when the destination location no longer names an element', () => {
    const home = writeFixture('Home.tsx', HOME)
    const about = writeFixture('About.tsx', ABOUT)
    const badge = locateTag(HOME, 'Badge')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: about,
      destinationLine: 999,
      destinationCol: 1,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('not-found')
    expectUntouched(home, HOME, about, ABOUT)
  })

  it('refuses no-jsx-parent when the moved element is what its component returns', () => {
    const homeText = `export default function Home() {
  return (
    <main className="home" />
  )
}
`
    const home = writeFixture('Home.tsx', homeText)
    const about = writeFixture('About.tsx', ABOUT)
    const root = locateTag(homeText, 'main')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: root.line,
      col: root.col,
      destinationFile: about,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('no-jsx-parent')
    expectUntouched(home, homeText, about, ABOUT)
  })
})

/**
 * `sec-17` — the same-file guard, driven with the two spellings that name one
 * file without being one string.
 *
 * This is not a tidiness check. When both ends resolve to the same bytes the
 * codemod loads them as two independent ts-morph source files, writes the
 * destination's spliced text, and then overwrites the whole file with the
 * origin's — which is the pre-edit text with the element CUT OUT. The element
 * is deleted from the user's repository and inserted nowhere, and the codemod
 * returns `ok: true`. So every assertion below checks the FILE as well as the
 * refusal: a guard that returns the right reason while the markup is gone
 * would be worth nothing.
 */
describe('transplantJsxElement — one file under two names', () => {
  it('refuses a destination that differs from the origin only in case', () => {
    const home = writeFixture('Home.tsx', HOME)
    // The same file, spelled the way a hand-crafted node id could spell it.
    // On a case-insensitive filesystem this opens the very same bytes.
    const aliased = path.join(tmpDir, 'home.tsx')
    if (!fs.existsSync(aliased)) return // case-sensitive filesystem: two real files, nothing to guard

    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(HOME, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: aliased,
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('same-file')
    expect(fs.readFileSync(home, 'utf8')).toBe(HOME)
  })

  it('refuses a destination reached through a symlinked directory', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    // A link of exactly the kind git stores and an imported repo can carry.
    // `'junction'` is the Windows-friendly directory link (no elevation
    // needed); POSIX ignores the type and makes an ordinary symlink.
    const linked = path.join(tmpDir, 'mirror')
    try {
      fs.symlinkSync(path.join(tmpDir, 'pages'), linked, 'junction')
    } catch {
      return // no permission to create links on this machine — nothing to drive
    }

    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(HOME, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: path.join(linked, 'Home.tsx'),
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('same-file')
    expect(fs.readFileSync(home, 'utf8')).toBe(HOME)
  })

  it('still moves between two genuinely different files reached through a link', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    writeFixture('pages/About.tsx', ABOUT)
    const linked = path.join(tmpDir, 'mirror')
    try {
      fs.symlinkSync(path.join(tmpDir, 'pages'), linked, 'junction')
    } catch {
      return
    }

    const badge = locateTag(HOME, 'Badge')
    const container = locateTag(ABOUT, 'main')

    const result = transplantJsxElement({
      file: home,
      line: badge.line,
      col: badge.col,
      destinationFile: path.join(linked, 'About.tsx'),
      destinationLine: container.line,
      destinationCol: container.col,
    })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'About.tsx'), 'utf8')).toContain(
      '<Badge tone="quiet">New</Badge>',
    )
    expect(fs.readFileSync(home, 'utf8')).not.toContain('<Badge')
  })
})
