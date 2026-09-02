/**
 * `pruneOrphanedImports` — the pass that keeps a delete from handing the user
 * a repository that no longer builds.
 *
 * Held to the same bar as the structural codemods it completes: assert the
 * WHOLE file, byte for byte. Every interesting failure here is comma and
 * whitespace arithmetic, and only a whole-file assertion catches a list that
 * lost its indentation or gained a stray `, ,`.
 *
 * The two-phase shape (snapshot which bindings are live, then prune the ones
 * that stopped being live) is what separates "this edit orphaned it" from "the
 * user already had an unused import" — the second is not ours to delete, and
 * there is a test for exactly that below.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createImportPruneSession, isPrunableSourceFile } from '../pruneOrphanedImports'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-imports-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Page.tsx'): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/** Snapshot, apply `edit` to the file's text, prune — the real batch sequence, compressed. */
function pruneAfter(source: string, edit: (text: string) => string): { text: string; removed: readonly string[] } {
  const file = writeFixture(source)
  const session = createImportPruneSession()
  const before = session.snapshot(file)
  fs.writeFileSync(file, edit(source), 'utf8')
  const removed = session.prune(file, before)
  return { text: fs.readFileSync(file, 'utf8'), removed }
}

describe('pruneOrphanedImports', () => {
  it('removes a declaration whose only binding lost its last reference', () => {
    const source = `import { Third } from './Third'

export default function Page() {
  return (
    <section>
      <Third />
    </section>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <Third />\n', ''))
    expect(removed).toEqual(['Third'])
    expect(text).toBe(source.replace("import { Third } from './Third'\n", '').replace('      <Third />\n', ''))
  })

  it('removes just the dead specifier from a shared declaration, keeping the survivors', () => {
    const source = `import { TabBar, Screen, ChevronUpIcon } from '@ds'

export default function Page() {
  return (
    <Screen>
      <TabBar />
      <ChevronUpIcon />
    </Screen>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <TabBar />\n', ''))
    expect(removed).toEqual(['TabBar'])
    expect(text).toBe(
      source.replace('{ TabBar, Screen, ChevronUpIcon }', '{ Screen, ChevronUpIcon }').replace('      <TabBar />\n', ''),
    )
  })

  // The shape a real design-system import actually has, and the one the bug was
  // reported against: a multi-line named list with a trailing comma.
  const MULTILINE = `import {
  Screen,
  TabBar,
  ChevronUpIcon,
} from '@alm-design/design-system'

export default function Page() {
  return (
    <Screen>
      <TabBar />
      <ChevronUpIcon />
    </Screen>
  )
}
`

  it('removes a middle specifier from a multi-line list without disturbing the rest', () => {
    const { text, removed } = pruneAfter(MULTILINE, (t) => t.replace('      <TabBar />\n', ''))
    expect(removed).toEqual(['TabBar'])
    expect(text).toBe(MULTILINE.replace('  TabBar,\n', '').replace('      <TabBar />\n', ''))
  })

  it('removes the LAST specifier of a multi-line list, leaving the trailing comma intact', () => {
    const { text, removed } = pruneAfter(MULTILINE, (t) => t.replace('      <ChevronUpIcon />\n', ''))
    expect(removed).toEqual(['ChevronUpIcon'])
    expect(text).toBe(MULTILINE.replace('  ChevronUpIcon,\n', '').replace('      <ChevronUpIcon />\n', ''))
  })

  // The case a per-edit check gets WRONG: asked while the other element is
  // still present, each of these looks live. Only after both are gone is
  // either one orphaned — which is the whole reason this runs once, at the end.
  it('removes both bindings when two elements deleted together shared the declaration', () => {
    const { text, removed } = pruneAfter(MULTILINE, (t) =>
      t.replace('      <TabBar />\n', '').replace('      <ChevronUpIcon />\n', ''),
    )
    expect([...removed].sort()).toEqual(['ChevronUpIcon', 'TabBar'])
    expect(text).toBe(
      MULTILINE.replace('  TabBar,\n', '')
        .replace('  ChevronUpIcon,\n', '')
        .replace('      <TabBar />\n', '')
        .replace('      <ChevronUpIcon />\n', ''),
    )
  })

  it('removes a whole multi-line declaration when every one of its bindings died', () => {
    const source = `import {
  TabBar,
  ChevronUpIcon,
} from '@alm-design/design-system'

export default function Page() {
  return (
    <section>
      <TabBar />
      <ChevronUpIcon />
    </section>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) =>
      t.replace('      <TabBar />\n', '').replace('      <ChevronUpIcon />\n', ''),
    )
    expect([...removed].sort()).toEqual(['ChevronUpIcon', 'TabBar'])
    expect(text).toBe(
      source
        .replace("import {\n  TabBar,\n  ChevronUpIcon,\n} from '@alm-design/design-system'\n", '')
        .replace('      <TabBar />\n', '')
        .replace('      <ChevronUpIcon />\n', ''),
    )
  })

  it('removes an orphaned asset import, not only component tags', () => {
    const source = `import hero from './hero.png'
import styles from './Page.module.css'

export default function Page() {
  return (
    <section className={styles.page}>
      <img src={hero} alt="" />
    </section>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <img src={hero} alt="" />\n', ''))
    expect(removed).toEqual(['hero'])
    expect(text).toBe(
      source.replace("import hero from './hero.png'\n", '').replace('      <img src={hero} alt="" />\n', ''),
    )
  })

  it('keeps a surviving default import when only its named siblings died', () => {
    const source = `import DS, { TabBar } from '@ds'

export default function Page() {
  return (
    <DS.Screen>
      <TabBar />
    </DS.Screen>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <TabBar />\n', ''))
    expect(removed).toEqual(['TabBar'])
    expect(text).toBe(source.replace('import DS, { TabBar }', 'import DS').replace('      <TabBar />\n', ''))
  })

  it('keeps surviving named imports when only the default died', () => {
    const source = `import DS, { TabBar } from '@ds'

export default function Page() {
  return (
    <DS.Screen>
      <TabBar />
    </DS.Screen>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) =>
      t.replace('    <DS.Screen>\n      <TabBar />\n    </DS.Screen>\n', '    <TabBar />\n'),
    )
    expect(removed).toEqual(['DS'])
    expect(text).toContain("import { TabBar } from '@ds'")
  })

  it('leaves an import that was ALREADY unused before the edit exactly where it was', () => {
    const source = `import { Screen, Unused } from '@ds'

export default function Page() {
  return (
    <Screen>
      <p>hi</p>
    </Screen>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <p>hi</p>\n', ''))
    expect(removed).toEqual([])
    expect(text).toBe(source.replace('      <p>hi</p>\n', ''))
  })

  it('leaves a side-effect import untouched — it binds nothing to orphan', () => {
    const source = `import '@ds/dist/index.css'
import { TabBar } from '@ds'

export default function Page() {
  return (
    <section>
      <TabBar />
    </section>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <TabBar />\n', ''))
    expect(removed).toEqual(['TabBar'])
    expect(text).toBe(source.replace("import { TabBar } from '@ds'\n", '').replace('      <TabBar />\n', ''))
  })

  it('writes nothing when the edit orphaned no binding', () => {
    const source = `import { Card } from './Card'

export default function Page() {
  return (
    <section>
      <Card id="a" />
      <Card id="b" />
    </section>
  )
}
`
    const { text, removed } = pruneAfter(source, (t) => t.replace('      <Card id="a" />\n', ''))
    expect(removed).toEqual([])
    expect(text).toBe(source.replace('      <Card id="a" />\n', ''))
  })

  it('only claims files it can parse', () => {
    expect(isPrunableSourceFile('/x/Page.tsx')).toBe(true)
    expect(isPrunableSourceFile('/x/Page.module.css')).toBe(false)
    expect(isPrunableSourceFile('/x/data.json')).toBe(false)
  })

  it('prunes nothing for a file that does not exist, rather than throwing', () => {
    expect(createImportPruneSession().prune(path.join(tmpDir, 'gone.tsx'), new Set(['X']))).toEqual([])
  })
})
