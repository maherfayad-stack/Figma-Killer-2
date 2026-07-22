/**
 * Cross-module integration proof for the Phase 0 loop.
 *
 * Proves the three primitives compose into the core round-trip that the whole
 * fork thesis depends on:
 *
 *   real .tsx  --(source-tags Babel plugin)-->  rendered element carries
 *   data-src-file/data-src-loc  --(parseSourceTag)-->  { file, line, col }
 *   --(ast-codemods setJsxProp)-->  the exact source element is rewritten.
 *
 * Also exercises component-manifest on the same fixture so we know the prop a
 * canvas would let you edit is actually discoverable.
 *
 * This is the auditor's composition test: each module is unit-tested in its own
 * directory; this asserts the SEAM between them (the line/col convention) holds
 * when a location emitted by the tagger is fed to the codemod.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from '@babel/core'
import sourceTagsPlugin from '../../source-tags/babelPluginSourceTags'
import { parseSourceTag } from '../../source-tags'
import { setJsxProp } from '../../ast-codemods'
import { extractManifest } from '../../component-manifest'

const BUTTON_TSX = `export interface ButtonProps {
  label: string
  variant?: 'primary' | 'secondary'
}

export function Button({ label, variant = 'primary' }: ButtonProps) {
  return <button className={variant}>{label}</button>
}
`

// Two self-closing <Button> elements on their own lines so the tagger emits a
// distinct location for each and the loc-extraction regex can't cross tags.
const HOME_TSX = `import { Button } from './Button'

export function Home() {
  return (
    <div>
      <Button label="First" variant="primary" />
      <Button label="Second" variant="secondary" />
    </div>
  )
}
`

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-sync-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Button.tsx'), BUTTON_TSX)
  writeFileSync(join(dir, 'Home.tsx'), HOME_TSX)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Every `data-src-loc` the tagger stamped onto a <Button>, in source order. */
function buttonLocsFromTaggedOutput(code: string): string[] {
  const locs: string[] = []
  const re = /<Button\b[^<>]*?data-src-loc="(\d+:\d+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) locs.push(m[1])
  return locs
}

test('tagger location drives the codemod to the exact source element', () => {
  const homePath = join(dir, 'Home.tsx')
  const source = readFileSync(homePath, 'utf8')

  // 1. Tag the source exactly as the build pipeline would.
  const out = transformSync(source, {
    filename: homePath,
    presets: ['@babel/preset-typescript'],
    plugins: [[sourceTagsPlugin, { root: dir }]],
    configFile: false,
    babelrc: false,
  })
  expect(out?.code).toBeTruthy()

  // 2. Two Buttons → two distinct emitted locations.
  const locs = buttonLocsFromTaggedOutput(out!.code!)
  expect(locs).toHaveLength(2)
  expect(locs[0]).not.toBe(locs[1])

  // 3. Read the SECOND Button's location back through the tagger's own reader,
  //    simulating a click on the rendered element.
  const fakeEl = {
    getAttribute: (n: string) =>
      n === 'data-src-file' ? 'Home.tsx' : n === 'data-src-loc' ? locs[1] : null,
  }
  const parsed = parseSourceTag(fakeEl)
  expect(parsed).not.toBeNull()
  expect(parsed!.file).toBe('Home.tsx')

  // 4. Drive the codemod with that location (file resolved app-relative → abs,
  //    exactly like the persistence adapter will).
  setJsxProp({
    file: join(dir, parsed!.file),
    line: parsed!.line,
    col: parsed!.col,
    prop: 'label',
    value: 'Clicked',
  })

  // 5. Only the SECOND Button changed.
  const after = readFileSync(homePath, 'utf8')
  expect(after).toContain('label="Clicked"') // second Button rewritten
  expect(after).toContain('label="First"') // first Button untouched
  expect(after).not.toContain('label="Second"') // old value gone
})

test('manifest discovers the editable prop the codemod targets', () => {
  const manifest = extractManifest(dir)
  const button = manifest.components.find((c) => c.name === 'Button')
  expect(button).toBeTruthy()

  const label = button!.props.find((p) => p.name === 'label')
  expect(label?.required).toBe(true)

  const variant = button!.props.find((p) => p.name === 'variant')
  expect(variant?.enumValues?.sort()).toEqual(['primary', 'secondary'])
})
