/**
 * CRLF regression gate for the vendored design system's doc slicer.
 *
 * `core.autocrlf=true` is the Git-for-Windows default, so a Windows clone of
 * this repo holds `vendor/alm-design-system/{CLAUDE.md,design.md}` with CRLF
 * while CI holds them with LF. `VendorDocs` finds each component's section
 * with `/^(#{1,6})\s+(.*)$/`, and in a JS regex `.` does NOT match `\r` — it
 * is a line terminator. So under CRLF that pattern matched ZERO headings,
 * `apiDoc()`/`intentDoc()` returned `null` for all 39 components, and
 * `buildDesignSystemManifest` emitted every one of them with `props: []` and
 * a placeholder `"<Name> component"` description. Two consequences, both
 * real:
 *
 *   - the Properties panel's generated inspector had no props to render and
 *     the Assets panel's cards/search had nothing to match on, for every
 *     design-system component, on any Windows checkout;
 *   - `bun run alm:sync` wrote that empty result OVER the committed
 *     `src/modules/alm/manifest.generated.json` (3,454 lines -> 641).
 *
 * The fix normalises line endings in `readVendorFile` — the single place that
 * knows how to read a vendored file — rather than sprinkling `\r?` through
 * every downstream regex. This gate feeds `VendorDocs` the SAME document
 * twice, once LF and once CRLF, and asserts the two parses are identical. It
 * does not read the vendored files at all, so it keeps holding whatever the
 * checkout's line endings happen to be.
 */
import { describe, expect, it } from 'bun:test'
import { VendorDocs } from '../vendorDocs'

const INDEX_JS = [
  "import './tokens/index.css'",
  '',
  "export { Button } from './components/Button'",
  "export { ListItem } from './components/List'",
  '',
].join('\n')

const CLAUDE_MD = [
  '# Design system',
  '',
  '### Button',
  '',
  '```jsx',
  '<Button',
  '  variant="primary"          // primary | secondary | destructive',
  '  label="Label"',
  '/>',
  '```',
  '',
  '- Text is set via the `label` prop',
  '',
  '### List / ListItem',
  '',
  '```jsx',
  '<ListItem title="Row" />',
  '```',
  '',
].join('\n')

const DESIGN_MD = [
  '# Design',
  '',
  '## Component Decision Map',
  '',
  '| Need | Use |',
  '| --- | --- |',
  '| A tappable action | Button |',
  '',
  '## Button',
  '',
  'The primary action control.',
  '',
  '## List / ListItem',
  '',
  'The selectable, scannable list row.',
  '',
].join('\n')

function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n')
}

function docsFor(eol: 'lf' | 'crlf'): VendorDocs {
  const convert = eol === 'crlf' ? toCrlf : (s: string) => s
  return new VendorDocs(convert(INDEX_JS), convert(CLAUDE_MD), convert(DESIGN_MD))
}

describe('VendorDocs — the same document parses identically under LF and CRLF', () => {
  it('finds the exported component names either way', () => {
    expect(docsFor('lf').componentNames).toEqual(['Button', 'ListItem'])
    expect(docsFor('crlf').componentNames).toEqual(['Button', 'ListItem'])
  })

  it('finds the API section under a plain heading either way', () => {
    expect(docsFor('lf').apiDoc('Button')).not.toBeNull()
    expect(docsFor('crlf').apiDoc('Button')).not.toBeNull()
  })

  it('finds the API section under a slash-spelled heading either way', () => {
    expect(docsFor('lf').apiDoc('ListItem')).not.toBeNull()
    expect(docsFor('crlf').apiDoc('ListItem')).not.toBeNull()
  })

  it('reads the same prop list either way — the failure that emptied the manifest', () => {
    expect(docsFor('lf').propsFor('Button')).toEqual(['label', 'variant'])
    expect(docsFor('crlf').propsFor('Button')).toEqual(['label', 'variant'])
  })

  it('reads the same intent section and heading alias either way', () => {
    expect(docsFor('lf').intentDoc('Button')).not.toBeNull()
    expect(docsFor('crlf').intentDoc('Button')).not.toBeNull()
    expect(docsFor('lf').intentHeadingTitle('ListItem')).toBe('List / ListItem')
    expect(docsFor('crlf').intentHeadingTitle('ListItem')).toBe('List / ListItem')
  })

  it('reads the cross-component Decision Map either way', () => {
    expect(docsFor('lf').decisionMap()).toContain('A tappable action')
    expect(docsFor('crlf').decisionMap()).toContain('A tappable action')
  })
})
