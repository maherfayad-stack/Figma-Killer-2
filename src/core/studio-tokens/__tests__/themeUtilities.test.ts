/**
 * themeUtilities - the Tailwind theme-name -> utility-class vocabulary (CT-6):
 * which namespace a variable belongs to, how a class is read out of a string
 * (variants, important marker, opacity), and the rewrite that moves one key.
 * A pantry-and-garden vocabulary, nothing from the eSIM corpus.
 */
import { describe, expect, it } from 'bun:test'
import {
  classWordsOf,
  isThemeNamespacedName,
  rewriteClassWords,
  sharedUtilityNamespaces,
  themeApplyClasses,
  themeClassNames,
  themeRenameBlockedReason,
  themeVariableOf,
} from '../themeUtilities'

describe('themeVariableOf', () => {
  it('finds the namespace and the key after the prefix', () => {
    expect(themeVariableOf('--color-moss-500')).toMatchObject({ key: 'moss-500', namespace: { prefix: '--color-' } })
    expect(themeVariableOf('--radius-jar')).toMatchObject({ key: 'jar', namespace: { prefix: '--radius-' } })
  })

  it('prefers the longest prefix: a weight is not a family, an inset shadow is not a shadow', () => {
    expect(themeVariableOf('--font-weight-bold')!.namespace.prefix).toBe('--font-weight-')
    expect(themeVariableOf('--font-serif')!.namespace.prefix).toBe('--font-')
    expect(themeVariableOf('--inset-shadow-deep')!.namespace.prefix).toBe('--inset-shadow-')
    expect(themeVariableOf('--text-shadow-soft')!.namespace.prefix).toBe('--text-shadow-')
  })

  it('an ordinary custom property is not a theme variable', () => {
    expect(themeVariableOf('--pantry-gap')).toBeNull()
    expect(themeVariableOf('--color-')).toBeNull()
    expect(isThemeNamespacedName('--pantry-gap')).toBe(false)
    expect(isThemeNamespacedName('--spacing')).toBe(true)
  })
})

describe('what a rename can follow', () => {
  it('names the namespaces whose readers it cannot find by spelling', () => {
    expect(themeRenameBlockedReason('--spacing-gate')).toContain('every spacing and sizing utility')
    expect(themeRenameBlockedReason('--breakpoint-wide')).toContain('responsive variant')
    expect(themeRenameBlockedReason('--spacing')).toContain('by name')
    expect(themeRenameBlockedReason('--color-moss')).toBeNull()
  })

  it('knows which utility prefixes two namespaces share', () => {
    const color = themeVariableOf('--color-moss')!.namespace
    expect(sharedUtilityNamespaces(color, 'text').map((ns) => ns.prefix)).toEqual(['--text-'])
    expect(sharedUtilityNamespaces(color, 'shadow').map((ns) => ns.prefix).sort()).toEqual(['--shadow-'])
    expect(sharedUtilityNamespaces(color, 'bg')).toEqual([])
  })
})

describe('the classes a variable is applied by', () => {
  it('lists the apply menu for a colour, a radius and a size', () => {
    expect(themeApplyClasses('--color-moss')).toEqual(['bg-moss', 'text-moss', 'border-moss', 'fill-moss', 'stroke-moss', 'ring-moss', 'outline-moss'])
    expect(themeApplyClasses('--radius-jar')).toEqual(['rounded-jar'])
    expect(themeApplyClasses('--text-label')).toEqual(['text-label'])
    expect(themeApplyClasses('--pantry-gap')).toEqual([])
    expect(themeApplyClasses('--spacing-gate')).toEqual([])
  })

  it('every utility spells <utility>-<key>', () => {
    const rounded = themeClassNames(themeVariableOf('--radius-jar')!.namespace, 'jar')
    expect(rounded).toContain('rounded-jar')
    expect(rounded).toContain('rounded-tl-jar')
  })
})

describe('classWordsOf', () => {
  it('reads the name out of variants, important markers and opacity', () => {
    const names = classWordsOf('bg-moss hover:md:text-moss !border-moss ring-moss! fill-moss/50 [&>p]:stroke-moss data-[state=open]:bg-moss').map((word) => word.name)
    expect(names).toEqual(['bg-moss', 'text-moss', 'border-moss', 'ring-moss', 'fill-moss', 'stroke-moss', 'bg-moss'])
  })

  it('keeps the offsets of the name only', () => {
    const text = 'a hover:bg-moss/50 b'
    const [, word] = classWordsOf(text)
    expect(text.slice(word!.start, word!.end)).toBe('bg-moss')
  })

  it('does not split on a colon or slash inside brackets', () => {
    expect(classWordsOf('bg-[url(a/b:c)]').map((word) => word.name)).toEqual(['bg-[url(a/b:c)]'])
  })
})

describe('rewriteClassWords', () => {
  it('moves only whole class names and keeps every other byte', () => {
    const from = new Set(['bg-moss', 'text-moss'])
    const result = rewriteClassWords('p-4 hover:bg-moss/50 !text-moss bg-moss-dark xbg-moss', (name) => (from.has(name) ? name.replace('moss', 'fern') : null))
    expect(result).toEqual({ text: 'p-4 hover:bg-fern/50 !text-fern bg-moss-dark xbg-moss', count: 2 })
  })
})
