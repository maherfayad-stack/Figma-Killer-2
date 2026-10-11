/**
 * classNameProp - G-2b: a component's root takes the `className` its call site
 * passes, joined to its own in the file's own idiom. One case per shape of the
 * root's class, one per refusal. The fixtures are a settings drawer, a badge
 * and a table row: nothing from the eSIM corpus or the pricing-tier project the
 * server tests use.
 */
import { describe, expect, it } from 'bun:test'
import { Node, Project, SyntaxKind } from 'ts-morph'
import { classNamesOnElement, ensureRootTakesClassName } from '../classNameProp'
import { functionLikesOf } from '../exposeLiteralSites'

function run(source: string): { text: string; result: ReturnType<typeof ensureRootTakesClassName> } {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } })
  const file = project.createSourceFile('Component.tsx', source)
  const fn = functionLikesOf(file)[0]!
  const root = fn.getFirstDescendantByKind(SyntaxKind.JsxOpeningElement) ?? fn.getFirstDescendantByKindOrThrow(SyntaxKind.JsxSelfClosingElement)
  const result = ensureRootTakesClassName(file, fn, root)
  return { text: file.getFullText(), result }
}

describe('ensureRootTakesClassName joins the call site\'s class in the file\'s own idiom', () => {
  it('an absent className becomes the prop itself', () => {
    const { text, result } = run('export function Badge({ label }: { label: string }) {\n  return <span>{label}</span>\n}\n')
    expect(result).toEqual({ ok: true, changed: true })
    expect(text).toBe('export function Badge({ label, className }: { label: string; className?: string }) {\n  return <span className={className}>{label}</span>\n}\n')
  })

  it('a string with no join helper in scope becomes a guarded template', () => {
    const { text } = run('export function Drawer({ open }: { open: boolean }) {\n  return <aside className="drawer">{String(open)}</aside>\n}\n')
    expect(text).toContain("<aside className={`drawer ${className || ''}`}>")
    expect(text).toContain('{ open, className }: { open: boolean; className?: string }')
  })

  it('a join helper in scope is the idiom, in whichever name the file uses', () => {
    const { text } = run("import clsx from 'clsx'\nexport function Row({ n }: { n: number }) {\n  return <tr className=\"row\">{n}</tr>\n}\n")
    expect(text).toContain('<tr className={clsx("row", className)}>')
  })

  it('a call to the helper takes one more argument; a member and a ternary are joined, not replaced', () => {
    expect(run("import { cn } from './cn'\nexport function A({ on }: { on: boolean }) {\n  return <i className={cn('a', on && 'b')} />\n}\n").text).toContain("cn('a', on && 'b', className)")
    expect(run("import s from './A.module.css'\nexport function B() {\n  return <i className={s.box} />\n}\n").text).toContain("<i className={`${s.box} ${className || ''}`} />")
    expect(run("export function C({ on }: { on: boolean }) {\n  return <i className={on ? 'x' : 'y'} />\n}\n").text).toContain("className={`${(on ? 'x' : 'y') || ''} ${className || ''}`}")
  })

  it('does nothing when the root already reads the className prop, however it is joined', () => {
    const source = 'export function D({ className }: { className?: string }) {\n  return <div className={`d ${className ?? ""}`} />\n}\n'
    const { text, result } = run(source)
    expect(result).toEqual({ ok: true, changed: false })
    expect(text).toBe(source)
  })

  it('a prop with no type annotation (JavaScript-style) gains the binding only', () => {
    const { text } = run('export function E({ title }) {\n  return <h1 className="e">{title}</h1>\n}\n')
    expect(text).toContain('{ title, className }')
    expect(text).not.toContain('className?: string')
  })
})

describe('what it will not do', () => {
  const reason = (source: string) => {
    const { result, text } = run(source)
    expect(text).toBe(source)
    return result.ok ? 'ok' : result.reason
  }

  it('an undestructured props parameter', () => {
    expect(reason('export function F(props: { a: string }) {\n  return <div className="f">{props.a}</div>\n}\n')).toBe('unsupported-params')
  })

  it('a className prop already used on another element would apply twice', () => {
    expect(reason('export function G({ className }: { className?: string }) {\n  return <div className="g"><span className={className} /></div>\n}\n')).toBe('class-prop-elsewhere')
  })

  it('a root that spreads props would replace its own class', () => {
    expect(reason('export function H({ ...rest }: { a?: string }) {\n  return <div className="h" {...rest} />\n}\n')).toBe('class-spread-root')
  })

  it('a className that means something else in the component', () => {
    expect(reason("export function I() {\n  const className = 'local'\n  return <div className=\"i\">{className}</div>\n}\n")).toBe('class-prop-conflict')
  })

  it('a className that is not a class string', () => {
    expect(reason('export function J() {\n  return <div className={{ a: 1 }} />\n}\n')).toBe('unsupported-class-expression')
  })
})

describe('classNamesOnElement', () => {
  it('reads the words of every string and the member a CSS Module binding is read at, evaluating nothing', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } })
    const file = project.createSourceFile('X.tsx', "export const x = <div className={cn('a b', on && 'c', `d ${e}`, styles.box, styles['wide-box'])} />\n")
    const element = file.getFirstDescendantByKindOrThrow(SyntaxKind.JsxSelfClosingElement)
    expect(Node.isJsxSelfClosingElement(element)).toBe(true)
    const names = classNamesOnElement(element)
    expect([...names.literals].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect([...names.members].sort()).toEqual(['box', 'wide-box'])
  })
})
