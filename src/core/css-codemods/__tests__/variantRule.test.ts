/**
 * variantRule — clone a top-level rule under a new selector, or remove one,
 * as a byte-exact splice. Generic stylesheets: a CSS module, a global sheet
 * with data-attribute selectors, comments, a rule that is last in the file,
 * and a rule that already exists.
 */
import { describe, expect, it } from 'bun:test'
import { cloneRule, removeRule, rewriteAttributeSelector, rewriteClassSelector } from '../variantRule'
import { applyTextSplices } from '@core/utils/textSplice'

const SHEET = ['.base {', '  padding: 4px;', '}', '', '.info {', '  color: blue;', '  background: #eef;', '}', '', '.warn {', '  color: orange;', '}', ''].join('\n')

function cloneInfo(css: string, name: string, line = 5): string {
  const result = cloneRule(css, { line, column: 1, selector: '.info' }, (selector) => rewriteClassSelector(selector, 'info', name))
  if (!result.ok) throw new Error(result.refusal.message)
  return result.splice ? applyTextSplices(css, [result.splice]) : css
}

describe('cloneRule', () => {
  it('copies the rule right after itself with the gap the file already uses', () => {
    expect(cloneInfo(SHEET, 'danger')).toBe(
      [
        '.base {', '  padding: 4px;', '}', '',
        '.info {', '  color: blue;', '  background: #eef;', '}', '',
        '.danger {', '  color: blue;', '  background: #eef;', '}', '',
        '.warn {', '  color: orange;', '}', '',
      ].join('\n'),
    )
  })

  it('copies the LAST rule of a file with the usual blank line, keeping the final newline', () => {
    const result = cloneRule(SHEET, { line: 10, column: 1, selector: '.warn' }, (selector) => rewriteClassSelector(selector, 'warn', 'hot'))
    if (!result.ok || !result.splice) throw new Error('expected a splice')
    expect(applyTextSplices(SHEET, [result.splice])).toBe(`${SHEET}\n.hot {\n  color: orange;\n}\n`)
  })

  it('keeps comments and odd spacing inside the copied rule', () => {
    const css = '.info{color:blue;/* calm */\n  margin : 0 }\n\n.warn { color: red }\n'
    const result = cloneRule(css, { line: 1, column: 1, selector: '.info' }, (selector) => rewriteClassSelector(selector, 'info', 'danger'))
    if (!result.ok || !result.splice) throw new Error('expected a splice')
    expect(applyTextSplices(css, [result.splice])).toBe(
      '.info{color:blue;/* calm */\n  margin : 0 }\n\n.danger{color:blue;/* calm */\n  margin : 0 }\n\n.warn { color: red }\n',
    )
  })

  it('rewrites a data-attribute selector in its own quote', () => {
    const css = '.btn[data-variant="solid"] {\n  color: white;\n}\n'
    const result = cloneRule(css, { line: 1, column: 1, selector: '.btn[data-variant="solid"]' }, (selector) =>
      rewriteAttributeSelector(selector, 'data-variant', 'solid', 'ghost'),
    )
    if (!result.ok || !result.splice) throw new Error('expected a splice')
    expect(applyTextSplices(css, [result.splice])).toBe(
      '.btn[data-variant="solid"] {\n  color: white;\n}\n\n.btn[data-variant="ghost"] {\n  color: white;\n}\n',
    )
  })

  it('does nothing when a rule with the new selector already exists', () => {
    const css = `${SHEET}\n.danger {\n  color: red;\n}\n`
    const result = cloneRule(css, { line: 5, column: 1, selector: '.info' }, (selector) => rewriteClassSelector(selector, 'info', 'danger'))
    expect(result.ok && result.existed && result.splice === null).toBe(true)
  })

  it('refuses a stale position, an unchanged selector, and Sass syntax', () => {
    const stale = cloneRule(SHEET, { line: 2, column: 1, selector: '.info' }, (selector) => `${selector}x`)
    expect(!stale.ok && stale.refusal.reason).toBe('stale-source')
    const same = cloneRule(SHEET, { line: 5, column: 1, selector: '.info' }, (selector) => selector)
    expect(!same.ok && same.refusal.reason).toBe('selector-unchanged')
    const sass = cloneRule('.a {\n  .b { color: red }\n  $x: 1\n', { line: 1, column: 1, selector: '.a' }, (selector) => `${selector}x`)
    expect(sass.ok).toBe(false)
  })
})

describe('removeRule', () => {
  it('removes the rule and the blank gap before it', () => {
    const result = removeRule(SHEET, { line: 5, column: 1, selector: '.info' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(applyTextSplices(SHEET, result.splices)).toBe(['.base {', '  padding: 4px;', '}', '', '.warn {', '  color: orange;', '}', ''].join('\n'))
  })

  it('removes the first rule with the gap after it', () => {
    const result = removeRule(SHEET, { line: 1, column: 1, selector: '.base' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(applyTextSplices(SHEET, result.splices).startsWith('.info {')).toBe(true)
  })

  it('round-trips a clone', () => {
    const cloned = cloneInfo(SHEET, 'danger')
    const result = removeRule(cloned, { line: 10, column: 1, selector: '.danger' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(applyTextSplices(cloned, result.splices)).toBe(SHEET)
  })

  it('refuses when the selector at the position is not the expected one', () => {
    const result = removeRule(SHEET, { line: 5, column: 1, selector: '.warn' })
    expect(!result.ok && result.refusal.reason).toBe('stale-source')
  })
})

describe('state rules travel with the member (CV-3 leftover)', () => {
  const STATES = [
    '.btn {',
    '  padding: 4px;',
    '}',
    '',
    '.primary {',
    '  color: blue;',
    '}',
    '',
    '.primary:hover,',
    '.primary:focus-visible {',
    '  color: navy;',
    '}',
    '',
    '.primary::before {',
    "  content: '';",
    '}',
    '',
    '.primary .icon {',
    '  width: 1em;',
    '}',
    '',
    '.primarycolor:hover {',
    '  color: red;',
    '}',
    '',
    '.warn {',
    '  color: orange;',
    '}',
    '',
  ].join('\n')

  const toDanger = (selector: string) => rewriteClassSelector(selector, 'primary', 'danger')

  it('Add copies .x:hover, .x:focus-visible and .x::before beside the copy, and leaves a descendant rule and a longer class alone', () => {
    const result = cloneRule(STATES, { line: 5, column: 1, selector: '.primary' }, toDanger)
    if (!result.ok || !result.splice) throw new Error('expected a splice')
    const copies = [
      '',
      '.danger {',
      '  color: blue;',
      '}',
      '',
      '.danger:hover,',
      '.danger:focus-visible {',
      '  color: navy;',
      '}',
      '',
      '.danger::before {',
      "  content: '';",
      '}',
    ].join('\n')
    expect(applyTextSplices(STATES, [result.splice])).toBe(STATES.replace('.primary {\n  color: blue;\n}', `.primary {\n  color: blue;\n}\n${copies}`))
  })

  it('Remove takes the member rule and its states, and the file stays whole', () => {
    const result = removeRule(STATES, { line: 5, column: 1, selector: '.primary' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(applyTextSplices(STATES, result.splices)).toBe(
      ['.btn {', '  padding: 4px;', '}', '', '.primary .icon {', '  width: 1em;', '}', '', '.primarycolor:hover {', '  color: red;', '}', '', '.warn {', '  color: orange;', '}', ''].join('\n'),
    )
  })

  it('Remove of the FIRST rule in the file takes its states and the gap after them', () => {
    const css = '.a { x: 1 }\n\n.a:hover { x: 2 }\n\n.b { x: 3 }\n'
    const result = removeRule(css, { line: 1, column: 1, selector: '.a' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(applyTextSplices(css, result.splices)).toBe('.b { x: 3 }\n')
  })

  it('an add followed by a remove is byte-exact', () => {
    const added = cloneRule(STATES, { line: 5, column: 1, selector: '.primary' }, toDanger)
    if (!added.ok || !added.splice) throw new Error('expected a splice')
    const withDanger = applyTextSplices(STATES, [added.splice])
    const removed = removeRule(withDanger, { line: 9, column: 1, selector: '.danger' })
    if (!removed.ok) throw new Error(removed.refusal.message)
    expect(applyTextSplices(withDanger, removed.splices)).toBe(STATES)
  })

  it('a state copy that already exists is not duplicated', () => {
    const css = '.a { x: 1 }\n\n.a:hover { x: 2 }\n\n.b:hover { x: 9 }\n'
    const result = cloneRule(css, { line: 1, column: 1, selector: '.a' }, (selector) => rewriteClassSelector(selector, 'a', 'b'))
    if (!result.ok || !result.splice) throw new Error('expected a splice')
    expect(applyTextSplices(css, [result.splice])).toBe('.a { x: 1 }\n\n.b { x: 1 }\n\n.a:hover { x: 2 }\n\n.b:hover { x: 9 }\n')
  })
})

describe('selector rewriters', () => {
  it('rewrites whole class names only', () => {
    expect(rewriteClassSelector('.btn.info, .info:hover', 'info', 'x')).toBe('.btn.x, .x:hover')
    expect(rewriteClassSelector('.information .info-box', 'info', 'x')).toBe('.information .info-box')
    expect(rewriteClassSelector('.btn-info', 'btn-info', 'btn-x')).toBe('.btn-x')
  })
  it('rewrites an attribute value in any quote', () => {
    expect(rewriteAttributeSelector("[data-v='a'], [data-v = a]", 'data-v', 'a', 'b')).toBe("[data-v='b'], [data-v = b]")
  })
})
