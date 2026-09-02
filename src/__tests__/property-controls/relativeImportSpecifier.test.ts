import { describe, expect, it } from 'bun:test'
import { relativeImportSpecifier } from '@site/property-controls/relativeImportSpecifier'

describe('relativeImportSpecifier', () => {
  it('same directory', () => {
    expect(relativeImportSpecifier('src/pages/Home.tsx', 'src/pages/Card.tsx')).toBe('./Card')
  })

  it('into a sibling subdirectory', () => {
    expect(relativeImportSpecifier('src/pages/Home.tsx', 'src/components/Card.tsx')).toBe('../components/Card')
  })

  it('into a nested subdirectory of the same parent', () => {
    expect(relativeImportSpecifier('src/pages/Home.tsx', 'src/pages/cards/Card.tsx')).toBe('./cards/Card')
  })

  it('strips the extension', () => {
    expect(relativeImportSpecifier('src/pages/Home.jsx', 'src/pages/Card.jsx')).toBe('./Card')
  })

  it('deeply nested source into a shallow target', () => {
    expect(relativeImportSpecifier('src/pages/blog/[slug]/Post.tsx', 'src/components/Card.tsx')).toBe(
      '../../../components/Card',
    )
  })
})
