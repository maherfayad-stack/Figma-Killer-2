/**
 * studioPastedHtmlStyles - the scoping rules for the CSS that comes with pasted
 * HTML, as a table. The writes through a real project are in
 * `studioInsertHtmlWrites.test.ts`; this holds the selector reading, which is
 * where "restyles more than the paste" would hide: attribute selectors with a
 * dot in them, escaped class names, `:not()`, `+` and `~`.
 *
 * Shares nothing with the eSIM corpus: a bike-repair shop's price list.
 */
import { describe, expect, it } from 'bun:test'
import { ClassNameTokens } from '@core/ast-codemods'
import { planPastedStyles, type StyleDestination } from '../studioPastedHtmlStyles'

const GLOBAL: StyleDestination = { kind: 'global', file: 'src/shop.css' }
const MODULE: StyleDestination = { kind: 'module', file: 'src/Shop.module.css', binding: 'styles' }

const price = (className: string, ...rest: { name: string; props?: Record<string, unknown> }[]) => [
  { name: 'div', props: { className }, children: rest },
]

function selectorsWritten(css: string, className = 'price', destination: StyleDestination | null = GLOBAL): string[] {
  return planPastedStyles(price(className), css, destination, new Set()).writes.map((write) => write.selector)
}

describe('which selectors are scoped to the paste', () => {
  it('writes a rule whose every selector holds one of the paste classes', () => {
    expect(selectorsWritten('.price { color: red } .price a:hover { color: blue } .price > p { margin: 0 } .price::before { content: "x" }')).toEqual([
      '.price',
      '.price a:hover',
      '.price > p',
      '.price::before',
    ])
    expect(selectorsWritten('.price, .price b { color: red }')).toEqual(['.price, .price b'])
    expect(selectorsWritten('.price.sale { color: red }', 'price sale')).toEqual(['.price.sale'])
  })

  it('skips a rule when ANY selector of its list is not scoped', () => {
    expect(selectorsWritten('.price, a { color: red }')).toEqual([])
    expect(selectorsWritten('.price, .other { color: red }')).toEqual([])
  })

  it('does not count a class inside :not() / :is() as scoping', () => {
    expect(selectorsWritten('a:not(.price) { color: red }')).toEqual([])
    expect(selectorsWritten(':is(.price, .other) { color: red }')).toEqual([])
    expect(selectorsWritten('.price a:not(.other) { color: red }')).toEqual(['.price a:not(.other)'])
  })

  it('refuses a selector that reaches siblings outside the paste (+, ~) but allows descendants (space, >)', () => {
    expect(selectorsWritten('.price + p { margin: 0 }')).toEqual([])
    expect(selectorsWritten('.price ~ .note { margin: 0 }')).toEqual([])
    expect(selectorsWritten('.price a + b { margin: 0 }')).toEqual(['.price a + b'])
    expect(selectorsWritten('.price > a { margin: 0 }')).toEqual(['.price > a'])
  })

  it('reads a dot inside an attribute selector or a string as part of that, not as a class', () => {
    expect(selectorsWritten('a[href$=".price"] { color: red }')).toEqual([])
    expect(selectorsWritten('.price a[href$=".pdf"] { color: red }')).toEqual(['.price a[href$=".pdf"]'])
    expect(selectorsWritten('[data-x=".price"] .other { color: red }')).toEqual([])
  })

  it('reads an escaped class name as the token the element carries', () => {
    expect(selectorsWritten('.md\\:flex { display: flex }', 'md:flex')).toEqual(['.md\\:flex'])
    expect(selectorsWritten('.w-1\\/2 { width: 50% }', 'w-1/2')).toEqual(['.w-1\\/2'])
  })

  it('never writes element, universal, root or attribute-only rules', () => {
    for (const css of ['p { margin: 0 }', '* { box-sizing: border-box }', 'body { margin: 0 }', ':root { --gap: 8px }', '[hidden] { display: none }', 'a:hover { color: red }']) {
      expect(selectorsWritten(css)).toEqual([])
    }
  })

  it('writes @media/@supports/@container around scoped rules and reports every other at-rule', () => {
    const plan = planPastedStyles(
      price('price'),
      '@media (min-width: 600px) { .price { padding: 8px } p { margin: 0 } } @supports (display: grid) { .price { display: grid } } @font-face { font-family: X; src: local(x) } @import "x.css"; @keyframes spin { to { opacity: 0 } } @layer base { .price { color: red } }',
      GLOBAL,
      new Set(),
    )
    expect(plan.writes).toEqual([
      { selector: '.price', declarations: { padding: '8px' }, atRule: 'media (min-width: 600px)' },
      { selector: '.price', declarations: { display: 'grid' }, atRule: 'supports (display: grid)' },
    ])
    expect(plan.summary.skipped).toEqual(['@font-face', '@import "x.css"', '@keyframes spin', '@layer base', 'p (in @media (min-width: 600px))'])
  })

  it('skips nested CSS and an unparseable stylesheet, naming them', () => {
    expect(planPastedStyles(price('price'), '.price { color: red; & a { color: blue } }', GLOBAL, new Set()).summary.skipped).toEqual(['.price (nested CSS)'])
    const broken = planPastedStyles(price('price'), '.price { color: red', GLOBAL, new Set())
    expect(broken.writes).toEqual([])
    expect(broken.summary.skipped).toEqual(['the stylesheet (it is not valid CSS)'])
  })
})

describe('declarations', () => {
  it('drops what the CSS sanitizer or the external-resource predicate refuses and counts it', () => {
    const plan = planPastedStyles(
      price('price'),
      '.price { color: red; background: url(https://x.example/a.png); width: expression(1); behavior: url(a.htc); -moz-binding: url(b); margin: 0 !important }',
      GLOBAL,
      new Set(),
    )
    expect(plan.writes[0]!.declarations).toEqual({ color: 'red', margin: '0 !important' })
    expect(plan.summary.droppedDeclarations).toBe(4)
  })

  it('writes nothing for a rule whose declarations were all refused', () => {
    const plan = planPastedStyles(price('price'), '.price { background: url(https://x.example/a.png) }', GLOBAL, new Set())
    expect(plan.writes).toEqual([])
    expect(plan.summary).toMatchObject({ mode: 'none', droppedDeclarations: 1 })
  })
})

describe('names already taken', () => {
  it('renames a taken class in the rule and on the element, and the next free name when -2 is taken too', () => {
    const plan = planPastedStyles(price('price'), '.price a { color: red } .price { margin: 0 }', GLOBAL, new Set(['price', 'price-2']))
    expect(plan.writes.map((write) => write.selector)).toEqual(['.price-3 a', '.price-3'])
    expect(plan.roots[0]!.props).toEqual({ className: 'price-3' })
    expect(plan.summary.renamed).toEqual([{ from: 'price', to: 'price-3' }])
  })

  it('leaves a class alone that the paste uses but no written rule names, even when it is taken', () => {
    const plan = planPastedStyles(price('price utility'), '.price { margin: 0 }', GLOBAL, new Set(['utility']))
    expect(plan.roots[0]!.props).toEqual({ className: 'price utility' })
    expect(plan.summary.renamed).toEqual([])
  })
})

describe('how the elements reach the rules', () => {
  it('a module destination turns written classes into binding members and keeps the others literal', () => {
    const plan = planPastedStyles(price('price tag-x'), '.price { margin: 0 }', MODULE, new Set())
    const className = plan.roots[0]!.props!.className
    expect(className).toBeInstanceOf(ClassNameTokens)
    expect((className as ClassNameTokens).expression()).toBe('`${styles.price} tag-x`')
    expect(planPastedStyles(price('price'), '.price { margin: 0 }', MODULE, new Set()).roots[0]!.props!.className).toBeInstanceOf(ClassNameTokens)
  })

  it('a module destination with no rule written leaves the className a plain string', () => {
    const plan = planPastedStyles(price('price'), 'p { margin: 0 }', MODULE, new Set())
    expect(plan.roots[0]!.props).toEqual({ className: 'price' })
  })

  it('no destination: single-class rules go onto the elements in stylesheet order, under the element own style, and the token goes', () => {
    const nodes = [
      { name: 'div', props: { className: 'price sale kept', style: { color: 'navy' } }, children: 'x' },
      { name: 'p', props: { className: 'other' }, children: 'y' },
    ]
    const plan = planPastedStyles(
      nodes,
      '.price { padding: 8px; color: red } .sale { padding: 4px; --accent: tomato } .price:hover { color: blue } .other { margin: 0 !important; margin-top: 2px }',
      null,
      new Set(),
    )
    expect(plan.writes).toEqual([])
    expect(plan.roots[0]!.props).toEqual({ className: 'kept', style: { padding: '4px', color: 'navy', '--accent': 'tomato' } })
    expect(plan.roots[1]!.props).toEqual({ style: { marginTop: '2px', margin: '0' } })
    expect(plan.summary).toMatchObject({ mode: 'inline', inlined: 3, skipped: ['.price:hover'] })
  })

  it('no destination and nothing inlinable reports and leaves every class on', () => {
    const plan = planPastedStyles(price('price'), '.price:hover { color: red }', null, new Set())
    expect(plan.roots[0]!.props).toEqual({ className: 'price' })
    expect(plan.summary).toMatchObject({ mode: 'none', skipped: ['.price:hover'] })
  })
})
