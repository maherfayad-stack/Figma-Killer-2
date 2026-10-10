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
import { localComponentJsxName, type LocalComponentSpec } from '@site/property-controls/componentPropKind'

function spec(name: string, file: string, role: LocalComponentSpec['role'] = 'component'): LocalComponentSpec {
  return { name, file, exportName: name, isDefaultExport: true, role, props: [] }
}

const CATALOG = [
  spec('SheetHeader', 'components/SheetHeader.tsx'),
  spec('OnboardingHero', 'components/OnboardingHero.tsx'),
  spec('Home', 'app/page.tsx', 'page'),
  spec('Welcome', 'pages/Welcome.tsx', 'page'),
  spec('LanguageProvider', 'components/LanguageProvider.tsx', 'provider'),
  spec('Button', 'design-system/Button.tsx'),
]

describe('insertableProjectComponents', () => {
  it("keeps the project's own components and drops pages, providers and the built-in design system", () => {
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

describe('localComponentJsxName', () => {
  it("writes a default export under its declared name, never the catalog's literal 'default'", () => {
    const sheet: LocalComponentSpec = { name: 'SheetHeader', file: 'components/SheetHeader.tsx', exportName: 'default', isDefaultExport: true, props: [] }
    expect(localComponentJsxName(sheet)).toBe('SheetHeader')
  })

  it('writes a named export under its export name', () => {
    const card: LocalComponentSpec = { name: 'CardImpl', file: 'components/Card.tsx', exportName: 'Card', isDefaultExport: false, props: [] }
    expect(localComponentJsxName(card)).toBe('Card')
  })
})
