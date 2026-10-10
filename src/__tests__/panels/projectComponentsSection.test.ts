/**
 * projectComponents — which catalog entries the Assets panel offers as
 * parts of a project, and how search narrows them. (The click/drag write is
 * `insertProjectComponent`; its wire shape is covered by the codemod's
 * `importStyle` tests and the structural-writeback suites.)
 */
import { describe, it, expect } from 'bun:test'
import {
  insertableProjectComponents,
  matchProjectComponents,
} from '@site/panels/AssetsPanel/projectComponents'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'

function spec(name: string, file: string): LocalComponentSpec {
  return { name, file, exportName: name, isDefaultExport: true, props: [] }
}

const CATALOG = [
  spec('SheetHeader', 'components/SheetHeader.tsx'),
  spec('OnboardingHero', 'components/OnboardingHero.tsx'),
  spec('Home', 'app/page.tsx'),
  spec('RootLayout', 'app/layout.tsx'),
  spec('Button', 'design-system/Button.tsx'),
]

describe('insertableProjectComponents', () => {
  it("keeps the project's own components and drops route files and the built-in design system", () => {
    expect(insertableProjectComponents(CATALOG).map((c) => c.name)).toEqual(['SheetHeader', 'OnboardingHero'])
  })
})

describe('matchProjectComponents', () => {
  const parts = insertableProjectComponents(CATALOG)

  it('returns everything for an empty query', () => {
    expect(matchProjectComponents(parts, '  ')).toHaveLength(2)
  })

  it('matches name or file, case-insensitively', () => {
    expect(matchProjectComponents(parts, 'sheet').map((c) => c.name)).toEqual(['SheetHeader'])
    expect(matchProjectComponents(parts, 'COMPONENTS/onb').map((c) => c.name)).toEqual(['OnboardingHero'])
    expect(matchProjectComponents(parts, 'nope')).toEqual([])
  })
})
