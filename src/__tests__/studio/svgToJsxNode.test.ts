/**
 * svgToJsxNode — the conversion that lets a design system's icon FILES reach
 * an icon slot at all.
 *
 * The source-writing cases are the ones that matter: they take a REAL icon out
 * of the vendored design system (`vendor/alm-design-system/`), convert it, and
 * hand the result to the REAL codemod (`insertJsxIntoSlotProp`) to write into a
 * fixture file. Conversion that produces a plausible-looking object is worth
 * nothing on its own — the question is whether what lands in the user's `.tsx`
 * is valid JSX that React renders as the icon. The codemod answers the first
 * half; `renderToStaticMarkup` over the converted tree answers the second.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { insertJsxIntoSlotProp } from '@core/ast-codemods'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'
import { convertSanitizedSvg, svgToJsxNode } from '@site/studio/svgToJsxNode'

const ALM_ICON = 'vendor/alm-design-system/src/icons/line-icons/chevronRight.svg'

function unwrap(result: ReturnType<typeof svgToJsxNode>) {
  if (!result.ok) throw new Error(`expected a converted node, got: ${result.message}`)
  return result.node
}

/**
 * Converts markup PAST `sanitizeSvg`. Only for what happy-dom cannot carry
 * through DOMPurify: its HTML parser mis-reads a `<style>` inside `<svg>`, so
 * DOMPurify under happy-dom drops the block and everything after it, where a
 * browser keeps it (DOMPurify's svg profile allows `style`). What is tested is
 * the conversion that runs on the sanitised document, identical either way.
 */
function convertParsed(markup: string) {
  return convertSanitizedSvg(new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement)
}

function childrenOf(node: SlotJsxNode): SlotJsxNode[] {
  return Array.isArray(node.children) ? node.children : []
}

/**
 * The converted tree as the React elements its JSX creates — built directly
 * from the node structure, so React sees exactly what `renderJsxNode` spells
 * (a string prop is a string attribute, an object is an `{…}` expression),
 * without evaluating any source text.
 */
function toReactElement(node: SlotJsxNode, key?: number): ReactNode {
  const props = { ...(node.props as Record<string, unknown> | undefined), key }
  if (typeof node.children === 'string') return createElement(node.name, props, node.children)
  return createElement(node.name, props, ...childrenOf(node).map((child, i) => toReactElement(child, i)))
}

/** Writes `node` into a fixture call site's `icon` prop through the real codemod and returns the file. */
function writeIntoSlot(node: SlotJsxNode): string {
  const dir = mkdtempSync(join(tmpdir(), 'svg-slot-'))
  const file = join(dir, 'Page.tsx')
  writeFileSync(file, ['export default function Page() {', '  return <Cell label="Wi-Fi" />', '}', ''].join('\n'), 'utf8')
  const result = insertJsxIntoSlotProp({ file, line: 2, col: 11, propName: 'icon', node })
  expect(result.ok).toBe(true)
  const written = readFileSync(file, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return written
}

describe('svgToJsxNode', () => {
  it('camelCases hyphenated SVG attributes so they are valid JSX', () => {
    const node = unwrap(
      svgToJsxNode('<svg viewBox="0 0 24 24"><path d="M9 4.5" stroke-linecap="round" stroke-width="1.5"/></svg>'),
    )
    expect(node.name).toBe('svg')
    expect(node.props).toEqual({ viewBox: '0 0 24 24' })
    const path = childrenOf(node)[0]!
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
    const written = writeIntoSlot(unwrap(svgToJsxNode(readFileSync(ALM_ICON, 'utf8'))))
    // The icon is inline: no import was needed, and no bundler plugin is
    // implied — the whole reason this path writes JSX instead of an import.
    expect(written).toContain('icon={<svg')
    expect(written).toContain('<path')
    expect(written).toContain('strokeLinecap="round"')
    expect(written).not.toContain('stroke-linecap')
    expect(written).not.toContain('import')
  })

  it('writes a style="…" icon into real source as attributes and a style OBJECT, never a string', () => {
    const written = writeIntoSlot(
      unwrap(svgToJsxNode('<svg viewBox="0 0 24 24"><path d="M0 0" style="fill:#fff;mix-blend-mode:multiply"/></svg>')),
    )
    expect(written).toContain('fill="#fff"')
    expect(written).toContain('style={{ mixBlendMode: "multiply" }}')
    expect(written).not.toContain('style="')
  })
})

// P1-E / audit 08-svg §2 defect 2: React throws on a string `style`, and
// every SVG exported from Illustrator, Figma or Inkscape carries them.
describe('svgToJsxNode — style="…" strings', () => {
  it('turns presentation properties into attributes and the rest into a style object', () => {
    const node = unwrap(
      svgToJsxNode('<svg viewBox="0 0 24 24"><path d="M0 0" style="fill:#fff;stroke-width:2;mix-blend-mode:multiply"/></svg>'),
    )
    expect(childrenOf(node)[0]!.props).toEqual({
      d: 'M0 0',
      fill: '#fff',
      strokeWidth: '2',
      style: { mixBlendMode: 'multiply' },
    })
  })

  it('lets a style declaration beat the presentation attribute it restates, as the cascade does', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1"><path d="M0 0" fill="red" style="fill: blue ; opacity:.5"/></svg>'))
    expect(childrenOf(node)[0]!.props).toEqual({ d: 'M0 0', fill: 'blue', opacity: '.5' })
  })

  it('keeps a value only CSS can resolve in the style object, where it still works', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1"><path d="M0 0" style="fill:var(--brand);stroke:#000"/></svg>'))
    expect(childrenOf(node)[0]!.props).toEqual({ d: 'M0 0', stroke: '#000', style: { fill: 'var(--brand)' } })
  })

  it('spells vendor-prefixed and custom properties the way React reads them', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1"><path d="M0 0" style="-webkit-filter:none;-ms-transform:none;--tone:1"/></svg>'))
    expect(childrenOf(node)[0]!.props!.style).toEqual({ WebkitFilter: 'none', msTransform: 'none', '--tone': '1' })
  })

  it('writes no style prop at all when every declaration became an attribute', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1" style="fill:none"><path d="M0 0"/></svg>'))
    expect(node.props).toEqual({ viewBox: '0 0 1 1', fill: 'none' })
  })
})

// P1-E / audit 08-svg §2 defect 3: Illustrator's `<style>.cls-1{…}</style>`.
describe('svgToJsxNode — <style> blocks', () => {
  const ILLUSTRATOR = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
    '<defs><style>.cls-1{fill:#f00;}.cls-2,.cls-3{fill:none;stroke:#000;stroke-miterlimit:10;}</style></defs>',
    '<path class="cls-1" d="M0 0"/>',
    '<path class="cls-2 keep" fill="blue" d="M1 1"/>',
    '<circle class="cls-1" style="fill:#0f0" r="1"/>',
    '</svg>',
  ].join('')

  it('inlines single-class rules onto the elements they match and drops the block', () => {
    const node = unwrap(convertParsed(ILLUSTRATOR))
    const [first, second, circle, ...rest] = childrenOf(node)
    expect(rest).toEqual([])
    expect(JSON.stringify(node)).not.toContain('"style"')
    expect(JSON.stringify(node)).not.toContain('defs')
    expect(first).toEqual({ name: 'path', props: { d: 'M0 0', fill: '#f00' } })
    // A rule beats the element's own presentation attribute; a class the
    // stylesheet never defined is the user's, and stays.
    expect(second).toEqual({
      name: 'path',
      props: { className: 'keep', fill: 'none', d: 'M1 1', stroke: '#000', strokeMiterlimit: '10' },
    })
    // The element's own style attribute beats the rule.
    expect(circle).toEqual({ name: 'circle', props: { r: '1', fill: '#0f0' } })
  })

  it("lets an !important rule beat the element's own style, as the cascade does", () => {
    const node = unwrap(
      convertParsed('<svg viewBox="0 0 1 1"><style>.a{fill:red !important}</style><path class="a" style="fill:blue" d="M0 0"/></svg>'),
    )
    expect(childrenOf(node)[0]!.props).toEqual({ d: 'M0 0', fill: 'red' })
  })

  it('keeps a data URI with a semicolon in it as one declaration', () => {
    const node = unwrap(
      convertParsed('<svg viewBox="0 0 1 1"><style>.a{fill:url("data:image/png;base64,AA==");opacity:0.5}</style><path class="a" d="M0 0"/></svg>'),
    )
    expect(childrenOf(node)[0]!.props).toEqual({ d: 'M0 0', fill: 'url("data:image/png;base64,AA==")', opacity: '0.5' })
  })

  it('refuses a rule it cannot inline with a sentence about the CSS, not about unsafe tags', () => {
    const result = convertParsed('<svg viewBox="0 0 1 1"><style>.a > .b{fill:red}</style><path d="M0 0"/></svg>')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('".a > .b"')
    expect(result.message).toContain('presentation attributes')
    expect(result.message).not.toContain('executes script')
  })

  it('refuses a type selector: it would match elements by tag, not by the classes being inlined', () => {
    const result = convertParsed('<svg viewBox="0 0 1 1"><style>path{fill:red}</style><path d="M0 0"/></svg>')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('"path"')
  })

  it('refuses an @-rule by name', () => {
    const result = convertParsed('<svg viewBox="0 0 1 1"><style>@media (min-width: 1px) { .a { fill: red } }</style></svg>')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('@media')
  })
})

// P1-E / audit 08-svg §2 defect 5: two inserts of one gradient icon.
describe('svgToJsxNode — ids', () => {
  const GRADIENT_ICON = [
    '<svg viewBox="0 0 24 24" aria-labelledby="t">',
    '<title id="t">Badge</title>',
    '<defs><linearGradient id="a"><stop offset="0" stop-color="#abc"/></linearGradient>',
    '<clipPath id="abc"><rect width="24" height="24"/></clipPath></defs>',
    `<path d="M0 0" fill="url(#a)" clip-path="url('#abc')" style="stroke:url(#a)" mask="url(#elsewhere)"/>`,
    '</svg>',
  ].join('')

  function idsAndRefs(node: SlotJsxNode) {
    const [title, defs, path] = childrenOf(node)
    const [gradient, clip] = childrenOf(defs!)
    return {
      root: node.props!,
      title: title!.props!,
      gradient: gradient!.props!,
      stop: childrenOf(gradient!)[0]!.props!,
      clip: clip!.props!,
      path: path!.props!,
    }
  }

  it('gives two inserts of the same icon distinct ids, each with its references rewritten to match', () => {
    const one = idsAndRefs(unwrap(svgToJsxNode(GRADIENT_ICON)))
    const two = idsAndRefs(unwrap(svgToJsxNode(GRADIENT_ICON)))

    expect(one.gradient.id).not.toBe(two.gradient.id)
    expect(one.clip.id).not.toBe(two.clip.id)
    for (const icon of [one, two]) {
      expect(String(icon.gradient.id)).toMatch(/^a-[0-9a-z]+$/)
      expect(icon.path.fill).toBe(`url(#${icon.gradient.id})`)
      expect(icon.path.stroke).toBe(`url(#${icon.gradient.id})`)
      expect(icon.path.clipPath).toBe(`url('#${icon.clip.id}')`)
      expect(icon.root['aria-labelledby']).toBe(icon.title.id)
      // A reference to something the file does not define is left alone, and
      // a colour that happens to spell an id is a colour.
      expect(icon.path.mask).toBe('url(#elsewhere)')
      expect(icon.stop.stopColor).toBe('#abc')
    }
  })

  it('rewrites a fragment href to the remapped id', () => {
    // `sanitizeSvg` strips href today (P5-D adds the fragment-only hook), so
    // this runs past it — the rewrite must already be right when that lands.
    const node = unwrap(
      convertParsed('<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><symbol id="s"/><use href="#s"/><use xlink:href="#s"/></svg>'),
    )
    const [symbol, use, legacy] = childrenOf(node)
    expect(use!.props!.href).toBe(`#${symbol!.props!.id}`)
    expect(legacy!.props!.xlinkHref).toBe(`#${symbol!.props!.id}`)
  })
})

// The bar the whole P1-E bundle sets: the JSX Studio writes must RENDER.
describe('svgToJsxNode — output renders under React', () => {
  let consoleError: Mock<typeof console.error>
  beforeEach(() => {
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  const cases: [string, () => ReturnType<typeof svgToJsxNode>][] = [
    [
      'a style="…" export',
      () =>
        svgToJsxNode(
          '<svg viewBox="0 0 24 24"><path d="M0 0" style="fill:#fff;stroke-width:2;mix-blend-mode:multiply;-webkit-filter:none;--tone:1"/></svg>',
        ),
    ],
    [
      'an Illustrator <style> export',
      () =>
        convertParsed(
          '<svg viewBox="0 0 24 24"><defs><style>.cls-1{fill:#f00;stroke-linecap:round}</style></defs><path class="cls-1" d="M0 0"/></svg>',
        ),
    ],
    [
      'a gradient icon',
      () =>
        svgToJsxNode(
          '<svg viewBox="0 0 24 24"><defs><linearGradient id="a" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0" fill="url(#a)"/></svg>',
        ),
    ],
  ]

  for (const [label, convert] of cases) {
    it(`renders ${label} without throwing or warning`, () => {
      const markup = renderToStaticMarkup(toReactElement(unwrap(convert())))
      expect(markup.startsWith('<svg')).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
    })
  }

  it('renders a converted style declaration as real CSS', () => {
    const node = unwrap(svgToJsxNode('<svg viewBox="0 0 1 1"><path d="M0 0" style="fill:#fff;mix-blend-mode:multiply"/></svg>'))
    const markup = renderToStaticMarkup(toReactElement(node))
    expect(markup).toContain('fill="#fff"')
    expect(markup).toContain('style="mix-blend-mode:multiply"')
  })
})
