/**
 * CT-5 - text and effect styles, real end to end (`realSourceHarness.ts`).
 *
 * `/save` is the editor's own journaled batch, `/load` the real parse of the
 * same files, and the store is loaded from that parse. Each gesture below goes
 * through the same planner and commit the inspector's picker calls, and its
 * undo is the store's own Cmd+Z - the journal's `restore` - compared to the
 * original bytes of EVERY file, stylesheet included.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { getStudioStyledRuleSources } from '@site/studio/styledRuleSources'
import { commitRestyle } from '@site/studio/textStyleCommit'
import { appliedStyle, discoverStyles, type DiscoveredStyle } from '@site/studio/textStyleDiscovery'
import { planApplyStyle, planCreateStyle, planDetachStyle, type RestyleInput } from '@site/studio/textStylePlan'
import { lockedStyleProperties } from '@site/inspector/commitApi'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const HOME = `import './Home.css'
import styles from './Card.module.css'

export default function Home() {
  return (
    <main className="home">
      <h1 style={{ fontSize: 40, fontWeight: 700, color: 'tomato' }}>Welcome</h1>
      <p className="heading">Section</p>
      <div style={{ boxShadow: '0 2px 6px #000' }}>Panel</div>
      <span className={styles.note}>Note</span>
      <i>Bare</i>
    </main>
  )
}
`

const HOME_CSS = `.home {
  display: grid;
}

.heading {
  font-size: 32px;
  font-weight: 700;
  line-height: 1.2;
}

.display {
  font-size: 48px;
  font-weight: 800;
  line-height: 1;
}

.soft {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.card {
  padding: 8px;
  font-size: 14px;
}
`

const CARD_MODULE_CSS = `.title {
  font-size: 20px;
  line-height: 1.3;
}

.note {
  margin: 0;
}
`

const FILES = { 'pages/Home.tsx': HOME, 'pages/Home.css': HOME_CSS, 'pages/Card.module.css': CARD_MODULE_CSS }

const store = () => useEditorStore.getState()
const page = () => store().site!.pages.find((p) => Object.keys(p.nodes).some((id) => id.startsWith('pages/Home.tsx:')))!
const nodeOnLine = (line: number) => Object.values(page().nodes).find((n) => n.id.includes(`:${line}:`))!

function inputFor(line: number): RestyleInput {
  const node = nodeOnLine(line)
  const styleRules = store().site!.styleRules
  const styles = discoverStyles(styleRules, { excludedRuleIds: new Set(Object.keys(getStudioStyledRuleSources())) })
  return { node, styleRules, styles, lockedStyleProps: lockedStyleProperties(node) }
}

function styleLabelled(input: RestyleInput, family: 'text' | 'effect', label: string): DiscoveredStyle {
  const found = input.styles[family].find((style) => style.label === label)
  if (!found) throw new Error(`no ${family} style ${label}`)
  return found
}

describe('CT-5 - discovery over the real parse', () => {
  let project: RealSourceProject
  beforeEach(async () => {
    project = await openRealSourceProject(FILES)
  })
  afterEach(() => project.close())

  it('finds the type and effect bundles in CSS and CSS Modules, and nothing that is a component class', () => {
    const input = inputFor(7)
    // `.title` is a module class: its label is the local name, never the compiled hash.
    expect(input.styles.text.map((s) => s.label)).toEqual(['display', 'heading', 'title'])
    expect(input.styles.effect.map((s) => s.label)).toEqual(['soft'])
    expect(input.styles.text.find((s) => s.label === 'heading')!.declarations).toEqual({
      fontSize: '32px',
      fontWeight: '700',
      lineHeight: '1.2',
    })
    // `.card` mixes padding with a size, `.home` is layout, `.note` is a margin: none is a style.
  })

  it('reads the style a layer carries from its classIds', () => {
    const input = inputFor(8)
    expect(appliedStyle(input.styles, 'text', input.node.classIds)?.label).toBe('heading')
    expect(appliedStyle(input.styles, 'text', inputFor(7).node.classIds)).toBeNull()
  })
})

describe('CT-5 - apply, create and detach are each one byte-exact undo', () => {
  let project: RealSourceProject
  const original = (): Record<string, string> => Object.fromEntries(Object.keys(FILES).map((rel) => [rel, project.read(rel)]))

  beforeEach(async () => {
    project = await openRealSourceProject(FILES)
    const loaded = await loadStudioPages(project.dir)
    setStudioStyleRuleSources(loaded.styleRuleSources, store().site!.styleRules)
  })
  afterEach(() => project.close())

  async function undoAndExpect(before: Record<string, string>, saves: number) {
    await project.waitFor(() => store().canUndo)
    store().undo()
    await project.waitFor(() => project.saves.length === saves)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[saves - 1]!.edits[0]!.kind).toBe('restore')
    for (const [rel, text] of Object.entries(before)) expect(project.read(rel)).toBe(text)
  }

  it('apply: the class goes on, the inline values it owns come off, one undo puts it all back', async () => {
    const before = original()
    const input = inputFor(7)
    const plan = planApplyStyle(input, styleLabelled(input, 'text', 'heading'))
    await commitRestyle(plan)
    expect(project.saves).toHaveLength(1)
    expect(project.saves[0]!.edits.map((e) => e.kind).sort()).toEqual(['class', 'style'])

    const after = project.read('pages/Home.tsx')
    expect(after).toContain("<h1 style={{ color: 'tomato' }} className=\"heading\">")
    // The stylesheet was not touched by an apply.
    expect(project.read('pages/Home.css')).toBe(before['pages/Home.css'])

    await undoAndExpect(before, 2)
  }, 30_000)

  it('apply swaps one style for another of its family instead of stacking both', async () => {
    const before = original()
    const input = inputFor(8)
    await commitRestyle(planApplyStyle(input, styleLabelled(input, 'text', 'display')))
    const after = project.read('pages/Home.tsx')
    expect(after).toContain('className="display"')
    expect(after).not.toContain('heading')
    await undoAndExpect(before, 2)
  }, 30_000)

  it('apply a CSS Module style adds the binding and the import, and undo removes both', async () => {
    const before = original()
    const input = inputFor(10)
    await commitRestyle(planApplyStyle(input, styleLabelled(input, 'text', 'title')))
    const after = project.read('pages/Home.tsx')
    expect(after).toContain('styles.title')
    expect(after).toContain('styles.note')
    await undoAndExpect(before, 2)
  }, 30_000)

  it('apply an effect style strips the inline shadow it replaces', async () => {
    const before = original()
    const input = inputFor(9)
    await commitRestyle(planApplyStyle(input, styleLabelled(input, 'effect', 'soft')))
    const after = project.read('pages/Home.tsx')
    expect(after).toContain('className="soft"')
    expect(after).not.toContain('boxShadow')
    await undoAndExpect(before, 2)
  }, 30_000)

  it('create: the rule is written, the class applied, the inline values moved into it - one undo', async () => {
    const before = original()
    const input = inputFor(7)
    const plan = planCreateStyle(input, 'text', 'Page title')
    expect(plan.ok).toBe(true)
    await commitRestyle(plan)

    const css = project.read('pages/Home.css')
    expect(css).toContain('.text-page-title')
    expect(css).toContain('font-size: 40px')
    expect(css).toContain('font-weight: 700')
    expect(css).not.toContain('tomato') // colour is not part of a text style
    const tsx = project.read('pages/Home.tsx')
    expect(tsx).toContain('className="text-page-title"')
    expect(tsx).toContain("style={{ color: 'tomato' }}")

    // The new rule is a style the next discovery finds, once.
    await project.waitFor(() => Object.values(store().site!.styleRules).some((r) => r.name === 'text-page-title'))
    const again = inputFor(7)
    expect(again.styles.text.filter((s) => s.label === 'text-page-title')).toHaveLength(1)

    await undoAndExpect(before, 2)
    expect(project.read('pages/Home.css')).not.toContain('text-page-title')
  }, 30_000)

  it('create refuses a name that is taken, with nothing written', async () => {
    const input = inputFor(7)
    const taken = planCreateStyle(input, 'text', 'Page title')
    await commitRestyle(taken)
    await project.waitFor(() => Object.values(store().site!.styleRules).some((r) => r.name === 'text-page-title'))
    const second = planCreateStyle(inputFor(8), 'text', 'page title')
    expect(second).toEqual({ ok: false, message: expect.stringContaining('text-page-title already exists') })
    expect(project.saves).toHaveLength(1)
  }, 30_000)

  it('create has nothing to save from a layer that sets no typography', () => {
    const plan = planCreateStyle(inputFor(11), 'text', 'Nothing')
    expect(plan.ok).toBe(false)
  })

  it('detach: the class comes off and its declarations land inline, one undo restores the file', async () => {
    const before = original()
    const input = inputFor(8)
    await commitRestyle(planDetachStyle(input, styleLabelled(input, 'text', 'heading')))
    const after = project.read('pages/Home.tsx')
    expect(after).not.toContain('heading')
    expect(after).toContain('fontSize')
    expect(after).toMatch(/fontSize: '32px'/)
    expect(after).toMatch(/lineHeight: '1.2'/)
    await undoAndExpect(before, 2)
  }, 30_000)

  it('create then detach hands back the literal values the layer started with', async () => {
    const start = inputFor(7)
    const startValues = { fontSize: start.node.inlineStyles!.fontSize, fontWeight: start.node.inlineStyles!.fontWeight }
    await commitRestyle(planCreateStyle(start, 'text', 'Round trip'))
    await project.waitFor(() => Object.values(store().site!.styleRules).some((r) => r.name === 'text-round-trip'))
    await project.waitFor(() => inputFor(7).node.classIds.length > 0)

    const created = inputFor(7)
    const style = styleLabelled(created, 'text', 'text-round-trip')
    await commitRestyle(planDetachStyle(created, style))
    await project.waitFor(() => inputFor(7).node.classIds.length === 0)

    const detached = inputFor(7).node.inlineStyles!
    // Same values, now spelled as CSS text: 40 -> '40px', 700 stays 700.
    expect(String(detached.fontSize)).toBe(`${startValues.fontSize}px`)
    expect(String(detached.fontWeight)).toBe(String(startValues.fontWeight))
    expect(detached.color).toBe('tomato')
  }, 30_000)

  it('detach refuses a style that also changes at a breakpoint', () => {
    const input = inputFor(8)
    const style = { ...styleLabelled(input, 'text', 'heading'), hasContextOverrides: true }
    const plan = planDetachStyle(input, style)
    expect(plan).toEqual({ ok: false, message: expect.stringContaining('breakpoints') })
  })
})
