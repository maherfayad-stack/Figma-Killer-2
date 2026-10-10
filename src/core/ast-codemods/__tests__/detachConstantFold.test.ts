/**
 * detach writes the branch a conditional takes, not the test that picks it
 * (P0-6). An instance detached so a gesture could land on it alone used to
 * leave `{'large' === 'large' ? <Sparkle/> : <Chevron/>}` and `{undefined && …}`
 * in the page, and an import for the branch that never renders.
 *
 * The fixture is a storefront banner — nothing shared with the eSIM corpus.
 * Every refusal-shaped case is here too: a condition that is not made of
 * literals must be written exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance } from '../detachComponent'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detach-fold-'))
  write('components/Sparkle.tsx', 'export function Sparkle() {\n  return <b>*</b>\n}\n')
  write('components/Chevron.tsx', 'export function Chevron() {\n  return <b>&gt;</b>\n}\n')
  write(
    'components/Banner.tsx',
    [
      "import { Chevron } from './Chevron'",
      "import { Sparkle } from './Sparkle'",
      '',
      'interface BannerProps {',
      "  size?: 'small' | 'large'",
      '  title: string',
      '  dismissible?: boolean',
      '  tone?: string',
      '}',
      '',
      "export function Banner({ size = 'small', title, dismissible, tone }: BannerProps) {",
      '  return (',
      "    <section className={size === 'large' ? 'banner banner--wide' : 'banner'}>",
      "      {size === 'large' ? <Sparkle /> : <Chevron />}",
      '      {dismissible && <button type="button">close</button>}',
      '      {tone ? <i className="tone" /> : null}',
      '      <h2>{title}</h2>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
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

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

function detachBanner(attributes: string): string {
  const source = [
    "import { Banner } from '../components/Banner'",
    '',
    'export default function Landing({ size }: { size: "small" | "large" }) {',
    `  return <Banner ${attributes} />`,
    '}',
    '',
  ].join('\n')
  const file = write('pages/Landing.tsx', source)
  const { line, col } = locateTag(source, 'Banner')
  const result = detachComponentInstance({ file, line, col, workspaceRoot: tmpDir })
  expect(result.ok).toBe(true)
  return read('pages/Landing.tsx')
}

describe('detach folds conditionals the call site decides', () => {
  it('writes the taken branch for a literal prop, and drops what cannot render', () => {
    const text = detachBanner('size="large" title="Hello" dismissible')
    expect(text).not.toContain('===')
    expect(text).not.toContain('undefined')
    expect(text).toContain('<Sparkle />')
    expect(text).not.toContain('<Chevron />')
    expect(text).toContain('<button type="button">close</button>')
    // `tone` was omitted: the ternary is `undefined ? … : null`, i.e. nothing.
    expect(text).not.toContain('<i ')
    expect(text).toContain('className="banner banner--wide"')
    // The import only the untaken branch needed is not carried across.
    expect(text).toContain("import { Sparkle } from '../components/Sparkle'")
    expect(text).not.toContain('Chevron')
  })

  it('takes the other branch when the default decides', () => {
    const text = detachBanner('title="Hello"')
    expect(text).toContain('<Chevron />')
    expect(text).not.toContain('Sparkle')
    expect(text).not.toContain('<button')
    expect(text).toContain('className="banner"')
  })

  it('leaves a conditional written as it was when the prop is not a literal', () => {
    const text = detachBanner('size={size} title="Hello"')
    expect(text).toContain("=== 'large' ?")
    expect(text).toContain('<Sparkle />')
    expect(text).toContain('<Chevron />')
  })
})
