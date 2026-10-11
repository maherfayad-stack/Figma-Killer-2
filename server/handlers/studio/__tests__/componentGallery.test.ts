/**
 * CV-2 — the variants gallery through the real `/load` pipeline: a component
 * with enum/boolean props becomes one derived page, one labelled cell per
 * combination, each cell a real inlined instance of the component.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPages } from '../../studioPageLoad'
import { galleryPageIdFromRoutePath } from '../componentGallery'

const FILES: Record<string, string> = {
  'pages/Home.tsx': `import { Button } from '../components/Button'
export default function Home() {
  return <main><Button label="Go" variant="ghost" /></main>
}
`,
  'components/Button.module.css': `.btn { padding: 4px; }
.primary { background: blue; }
.ghost { background: transparent; }
.danger { background: red; }
`,
  'components/Button.tsx': `import styles from './Button.module.css'
type Variant = 'primary' | 'ghost' | 'danger'
export interface ButtonProps {
  label: string
  variant?: Variant
  size?: 'sm' | 'md'
  disabled?: boolean
  onClick?: () => void
  children?: React.ReactNode
}
export function Button({ label, variant = 'primary', size = 'md', disabled = false, children }: ButtonProps) {
  return (
    <button className={styles[variant]} data-size={size} disabled={disabled}>
      {label}
      {children}
    </button>
  )
}
`,
  'components/Plain.tsx': `export function Plain({ title }: { title: string }) {
  return <h2>{title}</h2>
}
`,
  'components/Card.tsx': `export function Card({ elevated }: { elevated?: boolean }) {
  return <section data-elevated={elevated}>card</section>
}
`,
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-gallery-'))
  for (const [rel, text] of Object.entries(FILES)) {
    const full = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text, 'utf8')
  }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the Components variants gallery', () => {
  it('derives one page per component with variant axes, and none for a component without', async () => {
    const loaded = await loadStudioPages(root)
    expect(loaded.pages.map((page) => page.id).sort()).toEqual(['component-components-button', 'component-components-card', 'home'])
    expect(loaded.galleries.map((gallery) => gallery.componentName).sort()).toEqual(['Button', 'Card'])
    const button = loaded.galleries.find((gallery) => gallery.componentName === 'Button')!
    expect(button).toMatchObject({ shown: 12, total: 12, title: 'Components / Button', rowKey: 'components' })
  })

  it('renders one labelled, inlined instance per combination of the axes', async () => {
    const loaded = await loadStudioPages(root)
    const page = loaded.pages.find((candidate) => candidate.id === 'component-components-button')!
    const nodes = Object.values(page.nodes)

    // 3 variants x 2 sizes x 2 booleans, each a real instance of Button.
    const instances = nodes.filter((node) => node.moduleId === 'studio.instance')
    expect(instances).toHaveLength(12)

    const labels = nodes.map((node) => node.props.text).filter((text): text is string => typeof text === 'string')
    expect(labels).toContain('variant=primary, size=sm, disabled=false')
    expect(labels).toContain('variant=danger, size=md, disabled=true')

    // The inlined root is the component's own <button>: a composite id whose tail is Button.tsx.
    const roots = Object.keys(page.nodes).filter((id) => id.includes('#') && id.includes('~components/Button.tsx:'))
    expect(roots.length).toBeGreaterThanOrEqual(12)
  })

  it('renders the member each cell names: three variants resolve to three different rules', async () => {
    const loaded = await loadStudioPages(root)
    const page = loaded.pages.find((candidate) => candidate.id === 'component-components-button')!
    const classes = new Set(
      Object.entries(page.nodes)
        .filter(([id]) => id.includes('~components/Button.tsx:'))
        .flatMap(([, node]) => node.classIds ?? []),
    )
    expect(classes.size).toBeGreaterThanOrEqual(3)
  })

  it('writes nothing to the user source', async () => {
    const before = Object.keys(FILES).map((rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'))
    await loadStudioPages(root)
    const after = Object.keys(FILES).map((rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'))
    expect(after).toEqual(before)
  })

  it('names its cache key so a narrowed reload can read the page id back', () => {
    expect(galleryPageIdFromRoutePath('component-gallery:component-components-button')).toBe('component-components-button')
    expect(galleryPageIdFromRoutePath('pages/Home.tsx')).toBeNull()
  })
})
