/**
 * `G-8` — "Edit layout": structural gestures on a Next `layout.tsx` are allowed
 * in an explicit mode, and only in it.
 *
 * Real end to end (`realSourceHarness.ts`) on an App Router project: the layout
 * is composed into every route, so its nodes keep their `app/layout.tsx:l:c`
 * ids on every frame. What this pins:
 *
 *  - without the mode a delete on the layout is refused, writes nothing, and
 *    the dialog offers "Edit layout" (and the properties-panel notice and the
 *    Layers menu offer the same action, through the same constraint);
 *  - taking the remedy starts the SAME mode "Edit main component" uses
 *    (`mainEditTarget`), re-runs the delete, and the layout file changes — for
 *    every route that draws it;
 *  - ⌘Z is byte-exact and does not end the mode; "Done" does, and the gesture
 *    refuses again;
 *  - the mode is for ONE layout file: a segment layout, a template and a page
 *    keep their ordinary rules; and a project switch ends it.
 *
 * A pottery-studio site — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { layoutRouteCount, refuseStructuralEdit } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { noteBoardRead } from '@site/studio/sourceIdentity'
import { isStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { clearPageParseCache } from '../../../server/handlers/studio/pageParseCache'
import { clearStudioLoadMemo } from '../../../server/handlers/studio/studioLoadMemo'
import { probeProject } from '../../../server/handlers/studio/projectProbe'
import { mergeStudioMeta } from '../../../server/handlers/studio/studioMeta'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { makeSite } from '../fixtures'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const ROOT_LAYOUT = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <nav className="menu">
        <a href="/">Studio</a>
        <a href="/classes">Classes</a>
      </nav>
      {children}
      <footer>Open Tue to Sat</footer>
    </div>
  )
}
`

const CLASSES_LAYOUT = `export default function ClassesLayout({ children }: { children: React.ReactNode }) {
  return (
    <section className="classes">
      <aside>Bring an apron</aside>
      {children}
    </section>
  )
}
`

const HOME = `export default function Home() {
  return (
    <main>
      <h1>Wheel and kiln</h1>
    </main>
  )
}
`

const CLASSES = `export default function Classes() {
  return (
    <main>
      <h1>Evening classes</h1>
    </main>
  )
}
`

const store = () => useEditorStore.getState()

/** The layout's node whose text is `text`, as the first route's frame sees it. */
function layoutNode(text: string) {
  for (const page of store().site!.pages) {
    const node = Object.values(page.nodes).find((candidate) => candidate.props.text === text && candidate.id.includes('layout.tsx'))
    if (node) return node
  }
  throw new Error(`no layout node with text ${text}`)
}

const textsOf = (pageId: string) => Object.values(store().site!.pages.find((page) => page.id === pageId)!.nodes).map((node) => node.props.text)

describe('G-8 — Edit layout on a Next App Router project', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({
      'next.config.js': 'module.exports = {}\n',
      'app/layout.tsx': ROOT_LAYOUT,
      'app/page.tsx': HOME,
      'app/classes/layout.tsx': CLASSES_LAYOUT,
      'app/classes/page.tsx': CLASSES,
    })
    // An App Router board needs the probe's profile; the harness opened the folder before it existed.
    mergeStudioMeta(project.dir, { profile: probeProject(project.dir) })
    clearPageParseCache()
    clearStudioLoadMemo()
    const loaded = await loadStudioPages(project.dir)
    store().loadSite(makeSite({ pages: loaded.pages, styleRules: loaded.styleRules }))
    noteBoardRead(loaded.pages, 'reset')
  })
  afterEach(() => {
    store().setMainEditTarget(null)
    project.close()
  })

  it('the board has one frame per route and the layout is drawn by both', () => {
    expect(store().site!.pages.length).toBe(2)
    expect(layoutRouteCount(store().site!.pages, 'app/layout.tsx')).toBe(2)
    expect(layoutRouteCount(store().site!.pages, 'app/classes/layout.tsx')).toBe(1)
  })

  it('refuses a delete on the layout, offers "Edit layout", and writes nothing', () => {
    const footer = layoutNode('Open Tue to Sat')
    store().deleteNodes([footer.id])

    expect(project.saves).toHaveLength(0)
    const dialog = store().structuralRefusalDialog
    expect(dialog?.constraint.reason).toBe('route-chrome')
    expect(dialog?.constraint.actions.map((action) => action.kind)).toEqual(['edit-layout', 'jump-to-source'])
    expect(dialog?.replayRemedies?.editLayout).toBeTypeOf('function')
    expect(store().mainEditTarget).toBeNull()
    expect(project.read('app/layout.tsx')).toBe(ROOT_LAYOUT)
  })

  it('taking the remedy starts the shared mode, re-runs the delete on the layout file, and every route loses the footer', async () => {
    const footer = layoutNode('Open Tue to Sat')
    store().deleteNodes([footer.id])
    store().structuralRefusalDialog!.replayRemedies!.editLayout!()

    expect(store().mainEditTarget).toEqual({ kind: 'layout', rel: 'app/layout.tsx' })
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)
    expect(project.saves[0]!.edits.map((edit) => edit.kind)).toEqual(['delete'])
    expect(project.read('app/layout.tsx')).toBe(ROOT_LAYOUT.replace('      <footer>Open Tue to Sat</footer>\n', ''))
    // The other files are untouched, and both frames re-read the layout.
    expect(project.read('app/classes/layout.tsx')).toBe(CLASSES_LAYOUT)
    expect(project.read('app/page.tsx')).toBe(HOME)
    await project.waitFor(() => store().site!.pages.every((page) => !textsOf(page.id).includes('Open Tue to Sat')))

    // ⌘Z is byte-exact, and the mode is still on.
    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('app/layout.tsx')).toBe(ROOT_LAYOUT)
    expect(store().mainEditTarget).toEqual({ kind: 'layout', rel: 'app/layout.tsx' })
    await project.waitFor(() => store().site!.pages.every((page) => textsOf(page.id).includes('Open Tue to Sat')))
  })

  it('inside the mode a reorder in the layout is a write too; "Done" ends the mode and the next gesture refuses again', async () => {
    store().setMainEditTarget({ kind: 'layout', rel: 'app/layout.tsx' })
    const home = layoutNode('Studio')
    const classes = layoutNode('Classes')
    const nav = store().site!.pages[0]!.nodes[home.parentId!]!
    // Put "Classes" before "Studio".
    store().moveNode(classes.id, nav.id, 0)
    await project.waitFor(() => project.saves.length === 1)
    expect(project.saves[0]!.edits[0]!.kind).toBe('move')
    expect(project.read('app/layout.tsx')).toBe(
      ROOT_LAYOUT.replace('        <a href="/">Studio</a>\n        <a href="/classes">Classes</a>\n', '        <a href="/classes">Classes</a>\n        <a href="/">Studio</a>\n'),
    )
    await project.waitFor(() => store().canUndo && !isStructuralCommitInFlight())

    store().setMainEditTarget(null)
    store().deleteNodes([layoutNode('Open Tue to Sat').id])
    expect(project.saves).toHaveLength(1)
    expect(store().structuralRefusalDialog?.constraint.reason).toBe('route-chrome')
  })

  it('the mode is for the one layout file: a segment layout still refuses, and so does the same edit on a different file’s node', () => {
    store().setMainEditTarget({ kind: 'layout', rel: 'app/layout.tsx' })
    const aside = layoutNode('Bring an apron')
    expect(refuseStructuralEdit({ kind: 'delete', node: layoutNode('Open Tue to Sat') })).toBeNull()
    expect(refuseStructuralEdit({ kind: 'delete', node: aside })?.reason).toBe('route-chrome')

    store().deleteNodes([aside.id])
    expect(project.saves).toHaveLength(0)
    expect(store().structuralRefusalDialog?.constraint.reason).toBe('route-chrome')
    expect(project.read('app/classes/layout.tsx')).toBe(CLASSES_LAYOUT)
  })

  it('starting "Edit main component" ends the layout mode (one mode, one target), and a project switch ends either', () => {
    store().setMainEditTarget({ kind: 'layout', rel: 'app/layout.tsx' })
    expect(refuseStructuralEdit({ kind: 'delete', node: layoutNode('Open Tue to Sat') })).toBeNull()
    store().setMainEditTarget({ kind: 'component', name: 'Card' })
    expect(refuseStructuralEdit({ kind: 'delete', node: layoutNode('Open Tue to Sat') })?.reason).toBe('route-chrome')

    store().setMainEditTarget({ kind: 'layout', rel: 'app/layout.tsx' })
    // A first load of some other document: no baseline to rebase against, so the mode ends.
    store().loadSite(makeSite({ pages: [], styleRules: [] }))
    expect(store().mainEditTarget).toBeNull()
    expect(refuseStructuralEdit({ kind: 'delete', node: { id: 'app/layout.tsx:5:7' } })?.reason).toBe('route-chrome')
  })
})
