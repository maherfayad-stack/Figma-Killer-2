/**
 * subtreeFreeVariables — the free-variable walk every JSX-moving codemod and
 * detach's post-build gate share. A MISSED free variable produces code that
 * reads something out of scope, so each case here is a shape the walk used to
 * miss or misread.
 */
import { describe, expect, it } from 'bun:test'
import { Node, Project, SyntaxKind } from 'ts-morph'
import { analyzeFreeVariables, bindingKindAt, freeReferenceNames } from '../subtreeFreeVariables'

function parse(text: string) {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } })
  const file = p.createSourceFile('/app/Page.tsx', text)
  const marked = file.getFirstDescendant((n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n) || Node.isConditionalExpression(n))
  if (!marked) throw new Error('fixture has no JSX root')
  return { file, root: marked }
}

describe('analyzeFreeVariables / freeReferenceNames', () => {
  it('sees the expression of a `{...rest}` spread attribute (no JsxExpression around it)', () => {
    const { file, root } = parse('export function Page({ rest }) { return <div {...rest}>Hi</div> }\n')
    expect(analyzeFreeVariables(root, file).map((v) => v.name)).toEqual(['rest'])
  })

  it('sees the condition of a non-JSX root', () => {
    const { root } = parse('export function Page({ loading }) { return loading ? <i /> : <b /> }\n')
    expect(freeReferenceNames(root)).toEqual(['loading'])
  })

  it('counts a lowercase MEMBER tag as a reference to its root', () => {
    const { root } = parse("import { motion } from 'framer-motion'\nexport const Page = () => <motion.div />\n")
    expect(freeReferenceNames(root)).toEqual(['motion'])
  })

  it('does not read a namespaced attribute name as a reference', () => {
    const { root } = parse('export const Page = ({ href }) => <use xlink:href={href} />\n')
    expect(freeReferenceNames(root)).toEqual(['href'])
  })

  it('does not read an object-literal method name as a reference', () => {
    const { root } = parse('export const Page = ({ go }) => <a {...{ onClick() { go() } }} />\n')
    expect(freeReferenceNames(root)).toEqual(['go'])
  })
})

describe('bindingKindAt', () => {
  it('binds a for-of loop variable locally', () => {
    const text = [
      'export function Page(rows) {',
      '  for (const row of rows) {',
      '    console.error(<b>{row}</b>)',
      '  }',
      '}',
      '',
    ].join('\n')
    const p = new Project({ useInMemoryFileSystem: true })
    const file = p.createSourceFile('/app/Page.tsx', text)
    const element = file.getFirstDescendantByKindOrThrow(SyntaxKind.JsxElement)
    expect(bindingKindAt(element, 'row', file)).toBe('local')
    expect(bindingKindAt(element, 'rows', file)).toBe('local')
    expect(bindingKindAt(element, 'Page', file)).toBe('module')
    expect(bindingKindAt(element, 'window', file)).toBe('none')
  })
})
