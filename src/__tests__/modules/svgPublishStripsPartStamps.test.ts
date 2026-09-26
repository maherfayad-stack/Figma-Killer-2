/**
 * SVG-3 — the parser stamps each element inside a literal `<svg>` with where
 * it is written (`data-studio-svg-part`). A published page is the user's
 * output, not Studio's, so the stamps must not reach it — and removing them
 * must never turn sanitized markup back into live HTML.
 *
 * Security review #269 B1: the stamps used to be removed by a REGEX run on the
 * markup AFTER the publisher's sanitizer. A look-alike stamp inside `<text>`
 * made that regex delete across a tag boundary, and the published page gained
 * a live `<img onerror>` (stored XSS). The stamps are now removed INSIDE the
 * sanitizer (`sanitizeSvg` forbids both attributes), and nothing edits the
 * finished markup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registry } from '@core/module-engine'
import { escapeProps } from '@core/publisher'
import { createPageEvalBudget, parsePageFile } from '@core/page-parser'
import { sanitizeSvg } from '@core/sanitize'
import '@modules/base/svg'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-publish-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** The real pipeline: parse (stamps on) → the publisher's escapeProps → base.svg's render. */
function publish(pageSource: string): string {
  const file = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(file, pageSource, 'utf8')
  const page = parsePageFile(file, tmpDir, undefined, { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir })
  const svgNode = Object.values(page.nodes).find((node) => node.name === 'svg')!
  const svg = registry.get('base.svg')!
  const props = escapeProps({ svg: svgNode.props.svg }, svg.schema)
  const out = svg.render!(props as never, {} as never) as { html: string }
  return out.html
}

describe('base.svg publish', () => {
  it('B1 — a look-alike stamp inside <text> cannot turn sanitized markup into a live <img onerror>', () => {
    const html = publish(
      [
        'export default function Page() {',
        '  return (',
        '    <svg viewBox="0 0 10 10">',
        '      <text> data-studio-svg-part="</text>',
        '      <rect id="<img src=x onerror=alert(1)>" width="1"/>',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    // Parsed the way a browser parses the published page: no <img>, no handler
    // anywhere. (The payload survives only as inert TEXT of the rect's `id`.)
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
    expect(doc.querySelectorAll('img').length).toBe(0)
    expect(doc.querySelectorAll('[onerror]').length).toBe(0)
    expect(doc.querySelector('rect')?.getAttribute('id')).toBe('<img src=x onerror=alert(1)>')
    // Published markup is a fixed point of the sanitizer: nothing edited it afterwards.
    expect(sanitizeSvg(html)).toBe(html)
    // The look-alike in the text is the user's text, kept as text; the real stamps are gone.
    expect(doc.querySelector('text')?.textContent).toBe(' data-studio-svg-part="')
    expect(doc.querySelectorAll('[data-studio-svg-part]').length).toBe(0)
  })

  it('publishes the graphic without Studio part stamps', () => {
    const html = publish('export default function Page() {\n  return <svg viewBox="0 0 8 8"><g><path d="M0 0" /></g></svg>\n}\n')
    expect(html).not.toContain('data-studio-svg')
    expect(html).toContain('<path d="M0 0"')
  })

  it('the canvas profile keeps the stamps (they are its hit test); the default drops them', () => {
    const stamped = '<svg viewBox="0 0 8 8"><path data-studio-svg-part="2:3" data-studio-svg-code="d" d="M0 0"></path></svg>'
    expect(sanitizeSvg(stamped, { keepPartStamps: true })).toContain('data-studio-svg-part="2:3"')
    expect(sanitizeSvg(stamped)).not.toContain('data-studio-svg')
  })
})
