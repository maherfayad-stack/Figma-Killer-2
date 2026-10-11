/**
 * suggestVariableName - the name "Create variable from this value" offers.
 *
 * Derived from what the value IS (a colour, a length, a shadow), in the naming
 * the project already uses when it has one: a project whose spacing tokens are
 * `--spacing-*` gets `--spacing-16`, not Studio's own `--space-16`. Always
 * unique against the catalog, because a duplicate name would silently shadow
 * the existing token (the server refuses it too, `already-declared`).
 */
import type { VariableKind, VariableOption } from './variableKind'

const FAMILY_PREFIX: Readonly<Partial<Record<VariableKind, readonly string[]>>> = {
  color: ['color'],
  length: ['space', 'spacing'],
  number: ['number'],
  duration: ['duration'],
  'font-family': ['font'],
  shadow: ['shadow'],
}

/** `#0C9AB0` -> `0c9ab0`, `16px` -> `16`, `1.5rem` -> `1-5rem`, `"Inter", sans-serif` -> `inter`. */
function slugOf(kind: VariableKind, value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (kind === 'color') {
    const hex = /^#([0-9a-f]{3,8})$/.exec(trimmed)
    if (hex) return hex[1]!
    return 'custom'
  }
  if (kind === 'font-family') {
    const first = /^\s*["']?([^"',]+)/.exec(trimmed)?.[1]?.trim() ?? 'family'
    return first.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'family'
  }
  if (kind === 'shadow') return 'custom'
  const slug = trimmed.replace(/px$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'custom'
}

/** The prefix the catalog already uses for this kind of value, else the default. */
function prefixFor(kind: VariableKind, catalog: readonly VariableOption[]): string {
  const candidates = FAMILY_PREFIX[kind] ?? ['var']
  for (const candidate of candidates) {
    if (catalog.some((option) => option.kind === kind && option.name.startsWith(`--${candidate}-`))) return candidate
  }
  return candidates[0]!
}

export function suggestVariableName(kind: VariableKind, value: string, catalog: readonly VariableOption[]): string {
  const base = `--${prefixFor(kind, catalog)}-${slugOf(kind, value)}`
  const taken = new Set(catalog.map((option) => option.name))
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** True for a name the server will accept: custom-property syntax, no spaces. */
export function isValidVariableName(name: string): boolean {
  return /^--[A-Za-z0-9_-]+$/.test(name)
}

/** The name as the user typed it, with the leading dashes the field may have omitted. */
export function normalizeVariableName(typed: string): string {
  const trimmed = typed.trim()
  if (trimmed.startsWith('--')) return trimmed
  return `--${trimmed.replace(/^-+/, '')}`
}
