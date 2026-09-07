/**
 * nodeExportModel — the Export section's pure decisions (W8-4).
 *
 * Three things are worth pinning here, and all three are honesty properties
 * rather than formatting preferences:
 *
 *   1. SVG is offered only when the node genuinely HAS a vector form, and the
 *      refusal names WHICH case it is — never a raster wrapped in an `<svg>`.
 *   2. Copy CSS copies what is DECLARED, resolved through the provenance
 *      winner, and falls back to the real computed value (not to a guessed
 *      declaration) when the panel itself cannot say which class wins.
 *   3. A node with no class does not get an invented selector.
 */
import { describe, expect, it } from 'bun:test'
import {
  collectNodeCssDeclarations,
  exportFileName,
  exportScaleLabel,
  formatNodeCss,
  NODE_EXPORT_MENU,
  resolveNodeSvgExport,
  type NodeExportRow,
} from '../nodeExportModel'
import type { PropertyProvenance } from '../stylePropertyProvenance'

function provenance(
  property: string,
  overrides: Partial<PropertyProvenance> = {},
): [string, PropertyProvenance] {
  return [
    property,
    {
      property: property as PropertyProvenance['property'],
      sources: [],
      confidence: 'none',
      computedValue: undefined,
      inherited: false,
      ...overrides,
    },
  ]
}

const PNG_2X: NodeExportRow = { id: 'r1', format: 'png', scale: 2 }
const SVG_ROW: NodeExportRow = { id: 'r2', format: 'svg', scale: 1 }

describe('the typed + menu', () => {
  it('offers the three PNG densities, SVG, and the two code copies', () => {
    expect(NODE_EXPORT_MENU.map((entry) => entry.id)).toEqual([
      'png-1x',
      'png-2x',
      'png-3x',
      'svg',
      'copy-css',
      'copy-jsx',
    ])
  })

  it('adds a row for the image formats and runs immediately for the copies', () => {
    const kinds = new Map(NODE_EXPORT_MENU.map((entry) => [entry.id, entry.action.kind]))
    expect(kinds.get('png-2x')).toBe('add-row')
    expect(kinds.get('svg')).toBe('add-row')
    expect(kinds.get('copy-css')).toBe('copy-css')
    expect(kinds.get('copy-jsx')).toBe('copy-jsx')
  })
})

describe('row labels and file names', () => {
  it('shows a density for PNG and "Vector" for SVG', () => {
    expect(exportScaleLabel(PNG_2X)).toBe('2×')
    // SVG has no raster density — showing "1×" would be a number that means
    // nothing.
    expect(exportScaleLabel(SVG_ROW)).toBe('Vector')
  })

  it('names the file after the node, with the density suffix only above 1×', () => {
    expect(exportFileName('Hero title', PNG_2X)).toBe('Hero-title@2x.png')
    expect(exportFileName('Hero title', { id: 'r', format: 'png', scale: 1 })).toBe('Hero-title.png')
    expect(exportFileName('Logo', SVG_ROW)).toBe('Logo.svg')
  })

  it('falls back to a fixed stem rather than producing a nameless file', () => {
    expect(exportFileName('...', PNG_2X)).toBe('export@2x.png')
    expect(exportFileName('', SVG_ROW)).toBe('export.svg')
  })
})

describe('resolveNodeSvgExport — the honest-vector decision', () => {
  it('serves the parser’s own markup for an inline <svg>', () => {
    const result = resolveNodeSvgExport({
      moduleId: 'base.svg',
      props: { svg: '  <svg viewBox="0 0 10 10"><circle r="4" /></svg>  ' },
    })
    expect(result).toEqual({
      ok: true,
      source: 'inline',
      markup: '<svg viewBox="0 0 10 10"><circle r="4" /></svg>',
    })
  })

  it('serves an <img> whose src is an .svg asset — extension in the query, as the parse rewrites it', () => {
    const url = '/admin/api/studio/asset?dir=%2Fw%2Fproj&path=media%2Flogo.svg'
    expect(resolveNodeSvgExport({ moduleId: 'base.image', props: { src: url } })).toEqual({
      ok: true,
      source: 'asset',
      url,
    })
  })

  it('serves a plain .svg path and an image/svg+xml data URL', () => {
    expect(resolveNodeSvgExport({ moduleId: 'base.image', props: { src: '/assets/mark.svg#icon' } }).ok).toBe(true)
    expect(
      resolveNodeSvgExport({ moduleId: 'base.image', props: { src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }).ok,
    ).toBe(true)
  })

  it('refuses a raster <img> by name — wrapping pixels in an <svg> would be a lie', () => {
    const result = resolveNodeSvgExport({ moduleId: 'base.image', props: { src: '/assets/hero.png' } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('raster-image')
    expect(result.message).toContain('export PNG')
  })

  it('refuses ordinary HTML by name', () => {
    const result = resolveNodeSvgExport({ moduleId: 'base.container', props: { className: 'card' } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('rasterized-html')
  })

  it('distinguishes a base.svg the parser could not serialize from ordinary HTML', () => {
    // `inlineSvg.ts` declines on a spread-driven or oversized graphic, leaving
    // the node with no `svg` prop. That is its own reason, not "this is a div".
    const result = resolveNodeSvgExport({ moduleId: 'base.svg', props: { className: 'ring' } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('dynamic-svg')
  })

  it('does not mistake a non-svg markup string for an inline graphic', () => {
    const result = resolveNodeSvgExport({ moduleId: 'base.container', props: { svg: 'not markup' } })
    expect(result.ok).toBe(false)
  })
})

describe('collectNodeCssDeclarations', () => {
  it('copies the winning declaration and skips properties nothing declares', () => {
    const map = new Map([
      provenance('display', {
        sources: [{ kind: 'class', classId: 'c1', label: '.card', value: 'flex', winner: true }],
        confidence: 'exact-match',
        computedValue: 'flex',
      }),
      // Declared nowhere — a computed value alone is the UA's opinion, not
      // this element's design.
      provenance('color', { computedValue: 'rgb(0, 0, 0)' }),
    ])

    expect(collectNodeCssDeclarations(['display', 'color'], map)).toEqual([['display', 'flex']])
  })

  it('kebab-cases the property exactly the way the publisher emits it', () => {
    const map = new Map([
      provenance('backgroundColor', {
        sources: [{ kind: 'inline', label: 'Element', value: '#fff', winner: true }],
        confidence: 'inline',
      }),
      provenance('zIndex', {
        sources: [{ kind: 'inline', label: 'Element', value: 3, winner: true }],
        confidence: 'inline',
      }),
    ])

    expect(collectNodeCssDeclarations(['backgroundColor', 'zIndex'], map)).toEqual([
      ['background-color', '#fff'],
      ['z-index', '3'],
    ])
  })

  it('falls back to the real computed value when no source can be crowned winner', () => {
    // Two classes declare `gap` and the panel refuses to guess which rule
    // order wins. Copying one of them at random would be exactly the guess
    // `stylePropertyProvenance` exists to avoid; the frame's own computed
    // value is the honest answer.
    const map = new Map([
      provenance('gap', {
        sources: [
          { kind: 'class', classId: 'a', label: '.a', value: '4px', winner: false },
          { kind: 'class', classId: 'b', label: '.b', value: '12px', winner: false },
        ],
        confidence: 'ambiguous',
        computedValue: '12px',
      }),
    ])

    expect(collectNodeCssDeclarations(['gap'], map)).toEqual([['gap', '12px']])
  })

  it('skips an ambiguous property with no computed value rather than inventing one', () => {
    const map = new Map([
      provenance('gap', {
        sources: [
          { kind: 'class', classId: 'a', label: '.a', value: '4px', winner: false },
          { kind: 'class', classId: 'b', label: '.b', value: '12px', winner: false },
        ],
        confidence: 'ambiguous',
      }),
    ])

    expect(collectNodeCssDeclarations(['gap'], map)).toEqual([])
  })
})

describe('formatNodeCss', () => {
  it('wraps the declarations in the node’s own selector', () => {
    expect(
      formatNodeCss({
        title: 'Hero title',
        selector: '.hero.is-active',
        declarations: [
          ['display', 'flex'],
          ['gap', '8px'],
        ],
      }),
    ).toBe('/* Hero title */\n.hero.is-active {\n  display: flex;\n  gap: 8px;\n}\n')
  })

  it('emits bare declarations for an unclassed node instead of inventing a selector', () => {
    // A selector we made up would match nothing and name a class that exists
    // in no file.
    expect(
      formatNodeCss({ title: 'Element', declarations: [['color', 'red']] }),
    ).toBe('/* Element */\ncolor: red;\n')
  })

  it('says so when there is nothing set', () => {
    expect(formatNodeCss({ title: 'Element', declarations: [] })).toContain('Nothing is set')
  })
})
