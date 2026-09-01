/**
 * svgToJsxNode — the conversion that lets a design system's icon FILES reach
 * an icon slot at all.
 *
 * The last case is the one that matters: it takes a REAL icon out of the
 * installed `@alm-design/design-system`, converts it, and hands the result to
 * the REAL codemod (`insertJsxIntoSlotProp`) to write into a fixture file.
 * Conversion that produces a plausible-looking object is worth nothing on its
 * own — the question is whether what lands in the user's `.tsx` is valid JSX
 * that React renders as the icon, and only the codemod can answer that.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertJsxIntoSlotProp } from '@core/ast-codemods'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'

const ALM_ICON = 'node_modules/@alm-design/design-system/src/icons/line-icons/chevronRight.svg'

function unwrap(result: ReturnType<typeof svgToJsxNode>) {
  if (!result.ok) throw new Error(`expected a converted node, got: ${result.message}`)
  return result.node
}

describe('svgToJsxNode', () => {
  it('camelCases hyphenated SVG attributes so they are valid JSX', () => {
    const node = unwrap(
      svgToJsxNode('<svg viewBox="0 0 24 24"><path d="M9 4.5" stroke-linecap="round" stroke-width="1.5"/></svg>'),
    )
    expect(node.name).toBe('svg')
    expect(node.props).toEqual({ viewBox: '0 0 24 24' })
    const path = (node.children as { name: string; props?: Record<string, unknown> }[])[0]!
    expect(path.props).toEqual({ d: 'M9 4.5', strokeLinecap: 'round', strokeWidth: '1.5' })
  })

  it('renames `class` and keeps `aria-*` hyphenated, as JSX requires', () => {
    const node = unwrap(svgToJsxNode('<svg class="icon" aria-hidden="true" viewBox="0 0 1 1"></svg>'))
    expect(node.props).toEqual({ className: 'icon', 'aria-hidden': 'true', viewBox: '0 0 1 1' })
  })

  it('drops the xmlns plumbing React does not want', () => {
    const node = unwrap(svgToJsxNode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'))
    expect(node.props).toEqual({ viewBox: '0 0 1 1' })
  })

  it('strips a script before it is ever parsed', () => {
    // Sanitisation runs on the MARKUP, ahead of the DOM walk, so a script is
    // gone rather than skipped. DOMPurify drops the poisoned subtree wholesale
    // here — what this pins is that nothing executable survives into the node
    // tree, not how much of the rest is salvaged.
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0"/></svg>'))
    const names = JSON.stringify(node)
    expect(names).not.toContain('script')
    expect(names).not.toContain('alert')
  })

  it('drops an inline event handler attribute', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>'))
    expect(JSON.stringify(node)).not.toContain('alert')
  })

  it('refuses markup that is not an SVG document', () => {
    const result = svgToJsxNode('<div>not an icon</div>')
    expect(result.ok).toBe(false)
  })

  it('refuses an SVG with more elements than an icon has any business having', () => {
    const many = '<path d="M0 0"/>'.repeat(300)
    const result = svgToJsxNode(`<svg viewBox="0 0 1 1">${many}</svg>`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('too large')
  })

  // The end-to-end proof — a real package icon, the real codemod, real source.
  it('writes a real design-system icon into a real call site as valid JSX', () => {
    if (!existsSync(ALM_ICON)) return // the package is a dependency, not a fixture — skip if uninstalled
    const node = unwrap(svgToJsxNode(readFileSync(ALM_ICON, 'utf8')))

    const dir = mkdtempSync(join(tmpdir(), 'svg-slot-'))
    const file = join(dir, 'Page.tsx')
    writeFileSync(
      file,
      ['export default function Page() {', '  return <Cell label="Wi-Fi" />', '}', ''].join('\n'),
      'utf8',
    )

    const result = insertJsxIntoSlotProp({ file, line: 2, col: 11, propName: 'icon', node })
    expect(result.ok).toBe(true)

    const written = readFileSync(file, 'utf8')
    // The icon is inline: no import was needed, and no bundler plugin is
    // implied — the whole reason this path writes JSX instead of an import.
    expect(written).toContain('icon={<svg')
    expect(written).toContain('<path')
    expect(written).toContain('strokeLinecap="round"')
    expect(written).not.toContain('stroke-linecap')
    expect(written).not.toContain('import')
    rmSync(dir, { recursive: true, force: true })
  })
})
