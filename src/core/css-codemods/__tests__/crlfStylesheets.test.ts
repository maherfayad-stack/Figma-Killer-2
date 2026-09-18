/**
 * Every CSS codemod keeps the stylesheet's line ending.
 *
 * postcss holds the `\r\n` of nodes it did not touch in their `raws`, but
 * every string this folder builds — `raws.before = '\n\n'`, the literal
 * fragments in `buildRule`/`buildStep`/`buildRuleWithDeclarations` — is
 * written with `'\n'`. Left alone, one declaration edit turns a clean CRLF
 * stylesheet into a mixed one, which is how a user gets a `git diff` full of
 * lines they never touched. See `../preserveLineEndings.ts`.
 *
 * The fixture is a conference-programme stylesheet: nothing in it comes from
 * the eSIM corpus these codemods were first written against. The bytes are
 * built in the test rather than committed, because this repository's own
 * working tree is CRLF-converted on checkout and a committed CRLF fixture
 * cannot be trusted to still be CRLF when the test opens it.
 */
import { describe, expect, it } from 'bun:test'
import { insertRule, removeDeclaration, setDeclaration, setDeclarationAtMedia } from '../index'
import { insertKeyframes, removeDeclarationAtKeyframe, setDeclarationAtKeyframe } from '../keyframes'

const PROGRAMME_LINES = [
  '.programme {',
  '  display: grid;',
  '  gap: 16px;',
  '}',
  '',
  '.programme__slot {',
  '  padding: 8px;',
  '}',
  '',
  '@media (min-width: 720px) {',
  '  .programme {',
  '    gap: 24px;',
  '  }',
  '}',
  '',
]

const lf = (): string => PROGRAMME_LINES.join('\n')
const crlf = (): string => PROGRAMME_LINES.join('\r\n')

/** Every line ending in the text, as literal bytes. */
const endings = (text: string): string[] => [...text.matchAll(/\r\n|\r|\n/g)].map((m) => m[0])

function expectUniformCrlf(text: string): void {
  expect(new Set(endings(text))).toEqual(new Set(['\r\n']))
}

/** Runs `edit` on both twins: identical modulo endings, and the CRLF one stays uniformly CRLF. */
function expectTwinsAgree(edit: (css: string) => { css: string; changed: boolean }): string {
  const lfResult = edit(lf())
  const crlfResult = edit(crlf())
  expect(crlfResult.changed).toBe(lfResult.changed)
  expect(crlfResult.css.replace(/\r\n/g, '\n')).toBe(lfResult.css)
  expect(lfResult.css).not.toContain('\r')
  if (crlfResult.changed) expectUniformCrlf(crlfResult.css)
  return crlfResult.css
}

describe('a CRLF stylesheet stays CRLF', () => {
  it('setDeclaration — an existing declaration rewritten in place', () => {
    const out = expectTwinsAgree((css) => setDeclaration(css, '.programme', 'gap', '20px'))
    expect(out).toContain('  gap: 20px;\r\n')
    // Untouched lines were never re-emitted.
    expect(out).toContain('  padding: 8px;\r\n')
  })

  it('setDeclaration — a declaration ADDED to an existing rule', () => {
    const out = expectTwinsAgree((css) => setDeclaration(css, '.programme__slot', 'border-radius', '4px'))
    expect(out).toContain('border-radius: 4px;')
    expectUniformCrlf(out)
  })

  it('setDeclaration — a whole new rule appended to the end of the file', () => {
    const out = expectTwinsAgree((css) => setDeclaration(css, '.programme__title', 'font-weight', '600'))
    // The blank line `raws.before = "\n\n"` produces must be CRLF too.
    expect(out).toContain('\r\n\r\n.programme__title {\r\n')
  })

  it('setDeclarationAtMedia — into an existing @media block, and into a new one', () => {
    expectTwinsAgree((css) => setDeclarationAtMedia(css, '.programme', '(min-width: 720px)', 'gap', '32px'))
    const created = expectTwinsAgree((css) =>
      setDeclarationAtMedia(css, '.programme', '(min-width: 1200px)', 'gap', '40px'),
    )
    expect(created).toContain('@media (min-width: 1200px) {\r\n')
  })

  it('removeDeclaration — and the empty-block cleanup it triggers', () => {
    const out = expectTwinsAgree((css) => removeDeclaration(css, '.programme__slot', 'padding'))
    expect(out).not.toContain('padding')
    expect(out).not.toContain('.programme__slot')
  })

  it('insertRule — a multi-declaration rule, every inserted line CRLF', () => {
    const out = expectTwinsAgree((css) =>
      insertRule(css, '.programme__speaker', { color: '#334', 'font-size': '14px' }),
    )
    expect(out).toContain('  color: #334;\r\n')
    expect(out).toContain('  font-size: 14px;\r\n')
  })

  it('insertKeyframes / setDeclarationAtKeyframe / removeDeclarationAtKeyframe', () => {
    const withBlock = expectTwinsAgree((css) =>
      insertKeyframes(css, 'programme-fade', [
        { keyText: 'from', declarations: { opacity: '0' } },
        { keyText: 'to', declarations: { opacity: '1' } },
      ]),
    )
    expect(withBlock).toContain('@keyframes programme-fade {\r\n')
    expectUniformCrlf(withBlock)

    const stepped = setDeclarationAtKeyframe(withBlock, 'programme-fade', 'from', 'transform', 'translateY(4px)')
    expect(stepped.changed).toBe(true)
    expectUniformCrlf(stepped.css)

    const cleared = removeDeclarationAtKeyframe(stepped.css, 'programme-fade', 'from', 'transform')
    expect(cleared.changed).toBe(true)
    expect(cleared.css).toBe(withBlock)
  })
})

describe('what a line ending does NOT change', () => {
  it('returns the caller\'s OWN bytes for a no-op, never a re-serialised copy', () => {
    const source = crlf()
    // Already `16px`: nothing to do, so nothing — not even a line ending —
    // may be rewritten.
    const unchanged = setDeclaration(source, '.programme', 'gap', '16px')
    expect(unchanged.changed).toBe(false)
    expect(unchanged.css).toBe(source)

    const absent = removeDeclaration(source, '.programme', 'position')
    expect(absent.changed).toBe(false)
    expect(absent.css).toBe(source)

    const noSuchRule = removeDeclaration(source, '.nothing-here', 'gap')
    expect(noSuchRule.changed).toBe(false)
    expect(noSuchRule.css).toBe(source)
  })

  it('leaves a uniformly-LF stylesheet free of any \\r', () => {
    const out = setDeclaration(lf(), '.programme', 'gap', '20px')
    expect(out.css).not.toContain('\r')
  })

  it('normalises a MIXED stylesheet to its dominant ending', () => {
    const mixed = '.a {\r\n  color: red;\r\n}\n\n.b {\r\n  color: blue;\r\n}\r\n'
    const out = setDeclaration(mixed, '.a', 'color', 'green')
    expect(out.changed).toBe(true)
    expectUniformCrlf(out.css)
    expect(out.css).toContain('color: green;')
  })

  it('an empty stylesheet has no ending to preserve and gets LF', () => {
    const out = setDeclaration('', '.programme', 'gap', '8px')
    expect(out.changed).toBe(true)
    expect(out.css).not.toContain('\r')
  })
})
