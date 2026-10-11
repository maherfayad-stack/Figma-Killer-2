/**
 * variantNames — the one rule for what may be typed as a variant value or a
 * property name, and the one fact that tells a gallery page from any other
 * (the default board's seed asks it: a derived gallery is never one of "every
 * page" it lays out).
 */
import { describe, expect, it } from 'bun:test'
import { isGalleryGridNodeId, isGalleryPage, propNameError, variantNameError, VARIANT_NAME_PATTERN } from '../variantNames'

describe('variantNameError', () => {
  it('says nothing for an empty field, and nothing for a usable new name', () => {
    expect(variantNameError('', ['a'])).toBeNull()
    expect(variantNameError('  ', ['a'])).toBeNull()
    expect(variantNameError('danger', ['primary'])).toBeNull()
    expect(variantNameError('soft-blue_2', ['primary'])).toBeNull()
  })

  it('names what is wrong: an unusable character, a leading digit, a name that exists', () => {
    expect(variantNameError('two words', [])).toContain('Start with a letter')
    expect(variantNameError("it's", [])).toContain('Start with a letter')
    expect(variantNameError('9lives', [])).toContain('Start with a letter')
    expect(variantNameError('x'.repeat(41), [])).toContain('Start with a letter')
    expect(variantNameError('primary', ['primary'])).toContain('already exists')
  })

  it('the pattern is the one the codemods and the wire schema use', () => {
    expect(VARIANT_NAME_PATTERN.test('ghost')).toBe(true)
    expect(VARIANT_NAME_PATTERN.test('a"b')).toBe(false)
    expect(VARIANT_NAME_PATTERN.test('a\nb')).toBe(false)
  })
})

describe('propNameError', () => {
  it('accepts an identifier and refuses a taken or malformed one', () => {
    expect(propNameError('isOpen', ['label'])).toBeNull()
    expect(propNameError('$x', [])).toBeNull()
    expect(propNameError('1x', [])).toContain('plain name')
    expect(propNameError('a-b', [])).toContain('plain name')
    expect(propNameError('label', ['label'])).toContain('already exists')
  })
})

describe('isGalleryPage', () => {
  const page = (firstChild: string) => ({
    rootNodeId: 'p:body',
    nodes: { 'p:body': { children: [firstChild] }, [firstChild]: { children: [] } },
  })

  it('is a page whose body starts with the gallery grid', () => {
    expect(isGalleryGridNodeId('component-gallery:component-button:grid')).toBe(true)
    expect(isGalleryPage(page('component-gallery:component-button:grid'))).toBe(true)
  })

  it('is not an ordinary page, a story, a page with no body, or a gallery cell id', () => {
    expect(isGalleryPage(page('pages/Home.tsx:3:3'))).toBe(false)
    expect(isGalleryPage(page('component-gallery:component-button:cell:2'))).toBe(false)
    expect(isGalleryPage({ rootNodeId: 'missing', nodes: {} })).toBe(false)
  })
})
