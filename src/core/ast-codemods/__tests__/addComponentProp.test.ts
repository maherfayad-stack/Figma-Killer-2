/**
 * addComponentProp — one optional prop with a default, written into the
 * component's own signature. Generic components (`Avatar`, `Switch`, `Stat`)
 * in the shapes real repos write props in: an interface, a type alias, an
 * inline literal, a `...rest`, an arrow const, a default export, no parameter
 * at all — and the shapes it must refuse.
 */
import { describe, expect, it } from 'bun:test'
import { addComponentProp, type NewComponentProp } from '../addComponentProp'

const BOOL: NewComponentProp = { kind: 'boolean', name: 'rounded', defaultValue: true }

function add(source: string, exportName: string, prop: NewComponentProp = BOOL, fileName = 'Avatar.tsx'): string {
  const result = addComponentProp(fileName, source, exportName, prop)
  if (!result.ok) throw new Error(`${result.refusal.reason}: ${result.refusal.message}`)
  return result.source
}

describe('addComponentProp', () => {
  it('adds to a same-file interface, one member per line', () => {
    const source = ['interface AvatarProps {', '  src: string', '}', '', 'export function Avatar({ src }: AvatarProps) {', '  return <img src={src} />', '}', ''].join('\n')
    expect(add(source, 'Avatar')).toBe(
      ['interface AvatarProps {', '  src: string', '  rounded?: boolean;', '}', '', 'export function Avatar({ src, rounded = true }: AvatarProps) {', '  return <img src={src} />', '}', ''].join('\n'),
    )
  })

  it('adds to a type alias object and keeps a trailing ...rest last', () => {
    const source = "type Props = { src: string } & Record<string, never>\nexport function Avatar({ src, ...rest }: { src: string }) {\n  return <img src={src} {...rest} />\n}\n"
    expect(add(source, 'Avatar')).toContain('{ src, rounded = true, ...rest }: { src: string; rounded?: boolean }')
  })

  it('adds to an arrow const and to a default export', () => {
    expect(add("export const Stat = ({ value }: { value: number }) => <b>{value}</b>\n", 'Stat', { kind: 'text', name: 'unit', defaultValue: 'ms' })).toBe(
      "export const Stat = ({ value, unit = 'ms' }: { value: number; unit?: string }) => <b>{value}</b>\n",
    )
    expect(add('export default function Avatar({ src }: { src: string }) {\n  return <img src={src} />\n}\n', 'default')).toContain('{ src, rounded = true }: { src: string; rounded?: boolean }')
  })

  it('gives a component with no parameter a typed one', () => {
    const next = add('export function Avatar() {\n  return <img />\n}\n', 'Avatar')
    expect(next).toContain('export function Avatar({ rounded = true }: AvatarProps)')
    expect(next).toContain('rounded?: boolean')
  })

  it('writes a variant prop as a union with its first member as the default', () => {
    const next = add('export function Avatar({ src }: { src: string }) {\n  return <img src={src} />\n}\n', 'Avatar', { kind: 'variant', name: 'size', members: ['sm', 'md', 'lg'] })
    expect(next).toContain("{ src, size = 'sm' }: { src: string; size?: 'sm' | 'md' | 'lg' }")
  })

  it('escapes a quote in a text default', () => {
    expect(add("export function Avatar({ src }: { src: string }) {\n  return <img src={src} />\n}\n", 'Avatar', { kind: 'text', name: 'alt', defaultValue: "it's" })).toContain("alt = 'it\\'s'")
  })

  it('refuses by name: existing prop, reserved word, undestructured props, an imported props type, an unknown component, one-value variant', () => {
    const typed = 'export function Avatar({ src }: { src: string }) {\n  return <img src={src} />\n}\n'
    const reason = (source: string, exportName: string, prop: NewComponentProp) => {
      const result = addComponentProp('Avatar.tsx', source, exportName, prop)
      return result.ok ? 'ok' : result.refusal.reason
    }
    expect(reason(typed, 'Avatar', { kind: 'boolean', name: 'src', defaultValue: false })).toBe('prop-exists')
    expect(reason(typed, 'Avatar', { kind: 'boolean', name: 'default', defaultValue: false })).toBe('invalid-prop-name')
    expect(reason('export function Avatar(props: { src: string }) {\n  return <img src={props.src} />\n}\n', 'Avatar', BOOL)).toBe('unsupported-params')
    expect(reason("import type { Props } from './types'\nexport function Avatar({ src }: Props) {\n  return <img src={src} />\n}\n", 'Avatar', BOOL)).toBe('unsupported-props-type')
    expect(reason(typed, 'Missing', BOOL)).toBe('not-found')
    expect(reason(typed, 'Avatar', { kind: 'variant', name: 'size', members: ['only'] })).toBe('invalid-variant-name')
    expect(reason(typed, 'Avatar', { kind: 'variant', name: 'size', members: ['a b', 'c'] })).toBe('invalid-variant-name')
  })

  it('writes a JS component\'s binding with no type', () => {
    expect(add('export function Avatar({ src }) {\n  return <img src={src} />\n}\n', 'Avatar', BOOL, 'Avatar.jsx')).toBe(
      'export function Avatar({ src, rounded = true }) {\n  return <img src={src} />\n}\n',
    )
  })
})
