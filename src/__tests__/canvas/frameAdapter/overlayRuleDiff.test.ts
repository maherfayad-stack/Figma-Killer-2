import { describe, expect, it } from 'bun:test'
import { OverlayPatchError, OverlayRulePatcher, splitCssChunks, type RuleContainer } from '@site/canvas/frameAdapter/overlayRuleDiff'

/**
 * A stand-in for a `CSSStyleSheet`: it keeps rule OBJECTS (so identity, the
 * thing a browser's invalidation hangs on, can be asserted) and counts every
 * `insertRule` / `deleteRule`. A chunk containing "INVALID" is a `SyntaxError`,
 * as a malformed rule is in a browser.
 */
interface WriteCounts {
  inserts: number
  deletes: number
}

class FakeRule implements RuleContainer {
  readonly rules: FakeRule[] = []
  constructor(
    readonly cssText: string,
    readonly writes: WriteCounts,
  ) {}
  get cssRules(): FakeRule[] {
    return this.rules
  }
  insertRule(text: string, index = 0): number {
    if (text.includes('INVALID')) {
      const err = new Error('invalid rule')
      err.name = 'SyntaxError'
      throw err
    }
    const rule = new FakeRule(text, this.writes)
    const open = text.indexOf('{')
    if (/^@(layer|media)/.test(text) && open !== -1 && text.endsWith('}')) {
      for (const inner of splitCssChunks(text.slice(open + 1, -1))) rule.insertRule(inner, rule.rules.length)
    }
    this.rules.splice(index, 0, rule)
    this.writes.inserts += 1
    return index
  }
  deleteRule(index: number): void {
    this.rules.splice(index, 1)
    this.writes.deletes += 1
  }
}

function sheet(): FakeRule {
  return new FakeRule('', { inserts: 0, deletes: 0 })
}

function flatten(rule: FakeRule): string[] {
  return rule.rules.flatMap((child) => (child.rules.length > 0 ? [`${child.cssText.split('{')[0]!.trim()}{`, ...flatten(child), '}'] : [child.cssText]))
}

const LAYER = (body: string) => `@layer user-authored {\n${body}\n}`
const PRELUDE = '@layer reset, vendor, user-authored;'

describe('splitCssChunks', () => {
  it('cuts rules, at-rule statements and blocks, and drops comments between them', () => {
    expect(splitCssChunks('/* a */ .a { color: red } @layer x, y; .b{color:blue}\n@media (min-width: 10px) { .c { top: 0 } }')).toEqual([
      '.a { color: red }',
      '@layer x, y;',
      '.b{color:blue}',
      '@media (min-width: 10px) { .c { top: 0 } }',
    ])
  })

  it('does not split on braces or semicolons inside strings, comments and url()', () => {
    const rule = '.a::after { content: "}{;"; background: url(data:image/svg+xml;utf8,<svg xmlns=\'x\'>{}</svg>); /* } */ }'
    expect(splitCssChunks(`${rule} .b { top: 0 }`)).toEqual([rule, '.b { top: 0 }'])
  })

  it('keeps nested rules inside their parent chunk', () => {
    expect(splitCssChunks('.a { color: red; .b { top: 0 } } .c { top: 1 }')).toEqual(['.a { color: red; .b { top: 0 } }', '.c { top: 1 }'])
  })

  it('returns an unterminated tail as a chunk instead of looping', () => {
    expect(splitCssChunks('.a { color: red } .b { top')).toEqual(['.a { color: red }', '.b { top'])
  })
})

describe('OverlayRulePatcher', () => {
  it('builds the whole sheet on the first apply, a grouping block rule by rule', () => {
    const root = sheet()
    new OverlayRulePatcher(root).apply(`${PRELUDE}\n${LAYER('.a { top: 0 }\n.b { top: 1 }')}`)
    expect(flatten(root)).toEqual([PRELUDE, '@layer user-authored{', '.a { top: 0 }', '.b { top: 1 }', '}'])
  })

  it('applies identical text as no writes at all', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    const css = `${PRELUDE}\n${LAYER('.a { top: 0 }')}`
    patcher.apply(css)
    const before = { ...root.writes }
    const stats = patcher.apply(css)
    expect(root.writes).toEqual(before)
    expect(stats.inserted + stats.deleted).toBe(0)
  })

  it('one edited rule is one delete and one insert, every other rule object kept', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    patcher.apply(`${PRELUDE}\n${LAYER('.a { top: 0 }\n.b { top: 1 }\n.c { top: 2 }')}`)
    const layer = root.rules[1]!
    const [a, b, c] = layer.rules
    const stats = patcher.apply(`${PRELUDE}\n${LAYER('.a { top: 0 }\n.b { top: 99 }\n.c { top: 2 }')}`)
    expect(stats).toMatchObject({ inserted: 1, deleted: 1 })
    expect(root.rules[1]).toBe(layer)
    expect(layer.rules[0]).toBe(a)
    expect(layer.rules[1]).not.toBe(b)
    expect(layer.rules[1]!.cssText).toBe('.b { top: 99 }')
    expect(layer.rules[2]).toBe(c)
  })

  it('an inserted rule lands at its source position, a removed one leaves the rest in order', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    patcher.apply(LAYER('.a { top: 0 }\n.c { top: 2 }'))
    patcher.apply(LAYER('.a { top: 0 }\n.b { top: 1 }\n.c { top: 2 }'))
    expect(flatten(root)).toEqual(['@layer user-authored{', '.a { top: 0 }', '.b { top: 1 }', '.c { top: 2 }', '}'])
    patcher.apply(LAYER('.b { top: 1 }\n.c { top: 2 }'))
    expect(flatten(root)).toEqual(['@layer user-authored{', '.b { top: 1 }', '.c { top: 2 }', '}'])
    patcher.apply(LAYER(''))
    expect(root.rules).toHaveLength(1)
    expect(root.rules[0]!.rules).toHaveLength(0)
  })

  it('a block with a changed header is replaced, not diffed inside', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    patcher.apply('@media (max-width: 400px) { .a { top: 0 } }')
    const media = root.rules[0]
    patcher.apply('@media (max-width: 500px) { .a { top: 0 } }')
    expect(root.rules[0]).not.toBe(media)
    expect(root.rules[0]!.cssText).toContain('500px')
  })

  it('a block with the same header is edited in place', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    patcher.apply('@media (max-width: 400px) { .a { top: 0 } .b { top: 1 } }')
    const media = root.rules[0]!
    patcher.apply('@media (max-width: 400px) { .a { top: 0 } .b { top: 2 } }')
    expect(root.rules[0]).toBe(media)
    expect(media.rules[1]!.cssText).toBe('.b { top: 2 }')
  })

  it('reaches any target text from any other (randomised round trips)', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const pool = Array.from({ length: 12 }, (_, i) => `.r${i} { top: ${i}px }`)
    const draw = () => pool.filter(() => random() < 0.5)
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    for (let round = 0; round < 60; round += 1) {
      const rules = draw()
      patcher.apply(LAYER(rules.join('\n')))
      expect(flatten(root)).toEqual(rules.length > 0 ? ['@layer user-authored{', ...rules, '}'] : [])
    }
  })

  it('drops a rule the parser rejects but still skips it next time', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    const css = LAYER('.a { top: 0 }\n.b { INVALID }\n.c { top: 2 }')
    patcher.apply(css)
    expect(flatten(root)).toEqual(['@layer user-authored{', '.a { top: 0 }', '.c { top: 2 }', '}'])
    const before = { ...root.writes }
    patcher.apply(css)
    expect(root.writes).toEqual(before)
    patcher.apply(LAYER('.a { top: 0 }\n.b { INVALID }\n.c { top: 3 }'))
    expect(flatten(root)).toEqual(['@layer user-authored{', '.a { top: 0 }', '.c { top: 3 }', '}'])
  })

  it('throws, rather than corrupting the sheet, when someone else changed it', () => {
    const root = sheet()
    const patcher = new OverlayRulePatcher(root)
    patcher.apply(LAYER('.a { top: 0 }'))
    root.rules[0]!.rules.length = 0
    expect(() => patcher.apply(LAYER('.a { top: 1 }'))).toThrow(OverlayPatchError)
  })
})
