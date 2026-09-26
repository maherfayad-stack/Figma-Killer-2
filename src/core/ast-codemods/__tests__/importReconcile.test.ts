/**
 * importReconcile — identity, not spelling (audit 07 DET-1, bug 3).
 *
 * `addReconciledImports` used to trust any destination binding that merely
 * shared a NAME, so Card's `styles` silently became the page's `styles`.
 * These pin the replacement: an equivalent binding is reused, a different one
 * is aliased and the rename is returned, side-effect imports are carried, and
 * removing the last use of a default import keeps a mixed declaration
 * parseable.
 */
import { describe, expect, it } from 'bun:test'
import { Project, QuoteKind } from 'ts-morph'
import { addReconciledImports, mirrorSideEffectImports, removeImportIfLastUsage } from '../importReconcile'

function project(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } })
  p.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  for (const [name, text] of Object.entries(files)) p.createSourceFile(name, text)
  return p
}

describe('addReconciledImports', () => {
  it('aliases a name the destination binds to a DIFFERENT module, and returns the rename', () => {
    const p = project({
      '/app/components/Card.tsx': "import styles from './Card.module.css'\nexport const Card = () => <div className={styles.card} />\n",
      '/app/pages/Home.tsx': "import styles from './Home.module.css'\nexport const Home = () => <main className={styles.page} />\n",
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    const renames = addReconciledImports(page, p.getSourceFileOrThrow('/app/components/Card.tsx'), new Set(['styles']))
    expect(renames.get('styles')).toBe('cardStyles')
    expect(page.getFullText()).toContain("import styles from './Home.module.css'")
    expect(page.getFullText()).toContain("import cardStyles from '../components/Card.module.css'")
  })

  it('reuses an EQUIVALENT binding however it is spelled, writing nothing', () => {
    const p = project({
      '/app/components/Icon.tsx': 'export const Icon = () => <svg />\n',
      '/app/components/Card.tsx': "import { Icon } from './Icon'\nexport const Card = () => <Icon />\n",
      '/app/pages/Home.tsx': "import { Icon as Glyph } from '../components/Icon'\nexport const Home = () => <Glyph />\n",
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    const before = page.getFullText()
    const renames = addReconciledImports(page, p.getSourceFileOrThrow('/app/components/Card.tsx'), new Set(['Icon']))
    expect(renames.get('Icon')).toBe('Glyph')
    expect(page.getFullText()).toBe(before)
  })

  it('adds a plain import when the name is free', () => {
    const p = project({
      '/app/components/Icon.tsx': 'export const Icon = () => <svg />\n',
      '/app/components/Card.tsx': "import { Icon } from './Icon'\nexport const Card = () => <Icon />\n",
      '/app/pages/Home.tsx': 'export const Home = () => <main />\n',
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    const renames = addReconciledImports(page, p.getSourceFileOrThrow('/app/components/Card.tsx'), new Set(['Icon']))
    expect(renames.size).toBe(0)
    expect(page.getFullText()).toContain("import { Icon } from '../components/Icon'")
  })
})

describe('mirrorSideEffectImports', () => {
  it('carries a side-effect stylesheet import, re-specified against the destination', () => {
    const p = project({
      '/app/components/Card.tsx': "import './Card.css'\nexport const Card = () => <div />\n",
      '/app/pages/Home.tsx': 'export const Home = () => <main />\n',
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    mirrorSideEffectImports(page, p.getSourceFileOrThrow('/app/components/Card.tsx'))
    expect(page.getFullText()).toContain("import '../components/Card.css'")
  })

  it('does not duplicate a module the destination already loads', () => {
    const p = project({
      '/app/components/Card.tsx': "import './Card.css'\nexport const Card = () => <div />\n",
      '/app/pages/Home.tsx': "import '../components/Card.css'\nexport const Home = () => <main />\n",
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    const before = page.getFullText()
    mirrorSideEffectImports(page, p.getSourceFileOrThrow('/app/components/Card.tsx'))
    expect(page.getFullText()).toBe(before)
  })
})

describe('removeImportIfLastUsage', () => {
  it('drops only the default half of a mixed import, leaving a declaration that parses', () => {
    const p = project({
      '/app/pages/Home.tsx': "import Card, { CardIcon } from '../components/Card'\nexport const Home = () => <CardIcon />\n",
    })
    const page = p.getSourceFileOrThrow('/app/pages/Home.tsx')
    removeImportIfLastUsage(page, 'Card')
    expect(page.getFullText()).toContain("import { CardIcon } from '../components/Card'")
    expect(p.getProgram().getSyntacticDiagnostics(page)).toHaveLength(0)
  })
})
