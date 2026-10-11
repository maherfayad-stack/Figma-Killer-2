/**
 * CT-5 in a CSS Modules project (round-3 audit finding 6): every class lives in
 * `Probe.module.css` and every element is `className={styles.x}`. Applying a
 * style swaps one binding for another, and a created style is written into the
 * page's own module and applied through the file's binding. Real parse, real
 * writeback, byte-exact undo (`realSourceHarness.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { getStudioStyledRuleSources } from '@site/studio/styledRuleSources'
import { commitRestyle } from '@site/studio/textStyleCommit'
import { discoverStyles, type DiscoveredStyle } from '@site/studio/textStyleDiscovery'
import { planApplyStyle, planCreateStyle, planDetachStyle, type RestyleInput } from '@site/studio/textStylePlan'
import { lockedStyleProperties } from '@site/inspector/commitApi'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const PROBE = `import styles from './Probe.module.css'

export default function Probe() {
  return (
    <main className={styles.frame}>
      <h2 className={styles.greet}>Hello</h2>
      <p className={\`\${styles.counter} \${styles.muted}\`}>Count</p>
      <p style={{ fontSize: 30, fontWeight: 600 }}>Loose</p>
    </main>
  )
}
`

const PROBE_CSS = `.frame {
  display: grid;
}

.greet {
  font-size: 28px;
  font-weight: 700;
}

.counter {
  font-size: 12px;
  line-height: 1.4;
}

.strong {
  font-weight: 800;
  letter-spacing: 1px;
}

.muted {
  color: gray;
}
`

const FILES = { 'pages/Probe.tsx': PROBE, 'pages/Probe.module.css': PROBE_CSS }

const store = () => useEditorStore.getState()
const nodeOnLine = (line: number) => {
  const page = store().site!.pages.find((p) => Object.keys(p.nodes).some((id) => id.startsWith('pages/Probe.tsx:')))!
  return Object.values(page.nodes).find((n) => n.id.includes(`:${line}:`))!
}

function inputFor(line: number): RestyleInput {
  const node = nodeOnLine(line)
  const styleRules = store().site!.styleRules
  const styles = discoverStyles(styleRules, { excludedRuleIds: new Set(Object.keys(getStudioStyledRuleSources())) })
  return { node, styleRules, styles, lockedStyleProps: lockedStyleProperties(node) }
}

const labelled = (input: RestyleInput, label: string): DiscoveredStyle => {
  const found = input.styles.text.find((style) => style.label === label)
  if (!found) throw new Error(`no text style ${label}`)
  return found
}

describe('text styles in a CSS Modules project', () => {
  let project: RealSourceProject
  beforeEach(async () => {
    project = await openRealSourceProject(FILES)
    const loaded = await loadStudioPages(project.dir)
    setStudioStyleRuleSources(loaded.styleRuleSources, store().site!.styleRules)
  })
  afterEach(() => project.close())

  async function undoRestores(saves: number) {
    await project.waitFor(() => store().canUndo)
    store().undo()
    await project.waitFor(() => project.saves.length === saves)
    expect(project.read('pages/Probe.tsx')).toBe(PROBE)
    expect(project.read('pages/Probe.module.css')).toBe(PROBE_CSS)
  }

  it('apply swaps the element\'s bound style for another module class', async () => {
    const input = inputFor(6)
    const plan = planApplyStyle(input, labelled(input, 'counter'))
    expect(plan.ok).toBe(true)
    await commitRestyle(plan)
    const after = project.read('pages/Probe.tsx')
    expect(after).toContain('<h2 className={styles.counter}>')
    expect(after).not.toContain('styles.greet')
    expect(project.saves).toHaveLength(1)
    await undoRestores(2)
  }, 30_000)

  it('apply replaces one span of a class list and keeps the rest', async () => {
    const input = inputFor(7)
    await commitRestyle(planApplyStyle(input, labelled(input, 'greet')))
    expect(project.read('pages/Probe.tsx')).toContain('className={`${styles.muted} ${styles.greet}`}')
    await undoRestores(2)
  }, 30_000)

  it('apply on a layer with no class adds the binding', async () => {
    const input = inputFor(8)
    await commitRestyle(planApplyStyle(input, labelled(input, 'strong')))
    expect(project.read('pages/Probe.tsx')).toContain('className={styles.strong}')
    await undoRestores(2)
  }, 30_000)

  it('create writes the rule into the page\'s module and applies it through the binding', async () => {
    const input = inputFor(6)
    const plan = planCreateStyle(input, 'text', 'Big title')
    expect(plan.ok).toBe(true)
    await commitRestyle(plan)
    expect(project.read('pages/Probe.module.css')).toContain('.text-big-title')
    const tsx = project.read('pages/Probe.tsx')
    expect(tsx).toContain('className={styles["text-big-title"]}')
    expect(tsx).not.toContain('styles.greet')
    await undoRestores(2)
  }, 30_000)

  it('detach takes the bound style off and keeps its values inline', async () => {
    const input = inputFor(6)
    await commitRestyle(planDetachStyle(input, labelled(input, 'greet')))
    const after = project.read('pages/Probe.tsx')
    expect(after).not.toContain('styles.greet')
    expect(after).toMatch(/fontSize: '28px'/)
    await undoRestores(2)
  }, 30_000)
})
