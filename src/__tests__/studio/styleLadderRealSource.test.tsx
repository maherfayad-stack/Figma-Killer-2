/**
 * G-5 — a style edit never refuses; it lands, and the inspector SAYS where.
 *
 * Real end to end, on purpose. `/save` is `applyStudioEditBatchLocked` against
 * a temp workspace and the document comes from `loadStudioPages` over the same
 * files: the user's gesture is the store action the inspector calls, the diff
 * and the edit kinds are the adapter's own, the landing is the server's, and the
 * chip is the real component reading it. A hand-scripted response cannot catch
 * the join this module lives on — a `css` edit's synthetic id back to the class
 * rule the chip is asked about.
 *
 * One project per rung, none from the eSIM corpus: a pricing card in plain CSS,
 * a toggle in styled-components, and a section styled inline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { fsCodemodAdapter } from '@site/studio/fsCodemodAdapter'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { resetStyleLandings } from '@site/studio/styleLandings'
import { StyleLandingChip } from '@site/panels/PropertiesPanel/StyleLandingChip'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeSite } from '../fixtures'
import { applyStudioEditBatchLocked } from '../../../server/handlers/studioWriteback'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'

const PLAN_TSX = `import './Plan.css'

export default function Plan() {
  return (
    <section className="plan">
      <h2>Pro</h2>
    </section>
  )
}
`

let dir: string
let originalFetch: typeof globalThis.fetch

const read = (rel: string) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
function write(rel: string, text: string): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

/** `/save` is the route's own batch (journaled, as the editor's is); everything else answers an empty object. */
function installRealServer(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = (typeof input === 'string' ? input : input.toString()).split('?')[0]
    if (route === '/admin/api/studio/save') {
      const body = JSON.parse(String(init?.body)) as { edits: Parameters<typeof applyStudioEditBatchLocked>[1] }
      const result = await applyStudioEditBatchLocked(dir, body.edits, {}, { canvasLayers: 'allow', journal: true })
      return new Response(
        JSON.stringify({
          ok: true,
          ...result,
          touchedFiles: result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')),
        }),
        { status: 200 },
      )
    }
    // A shifted write asks whether a narrow reload is safe; "no" is the answer this test never reads.
    if (route === '/admin/api/studio/reload-scope') return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

/** Opens `dir` the way a Studio load does: the document, the style registry and the diff baseline. */
async function openProject(): Promise<ReturnType<typeof loadStudioPages> extends Promise<infer R> ? R : never> {
  const loaded = await loadStudioPages(dir)
  setStudioLoadedDir(dir)
  setStudioStyleRuleSources(loaded.styleRuleSources, loaded.styleRules, {
    pages: loaded.pages,
    styledSources: loaded.styledStyleRuleSources,
  })
  useEditorStore.getState().loadSite(makeSite({ pages: loaded.pages, styleRules: loaded.styleRules }))
  return loaded
}

async function save(): Promise<void> {
  await fsCodemodAdapter.saveSite(useEditorStore.getState().site!)
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-style-ladder-real-')))
  __resetToastBusForTests()
  resetStyleLandings()
  originalFetch = globalThis.fetch
  installRealServer()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  setStudioLoadedDir(null)
  useEditorStore.getState().clearSite()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a class in a .css file', () => {
  function planRule(loaded: Awaited<ReturnType<typeof openProject>>) {
    return Object.values(loaded.styleRules).find((rule) => rule.selector === '.plan')!
  }

  it('rung 1: rewriting its own declaration says "Saved in Plan.css", with no Undo to offer', async () => {
    write('pages/Plan.tsx', PLAN_TSX)
    write('pages/Plan.css', '.plan {\n  color: red;\n  padding: 8px;\n}\n')
    const rule = planRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { color: 'navy' })
    await save()

    expect(read('pages/Plan.css')).toBe('.plan {\n  color: navy;\n  padding: 8px;\n}\n')
    render(<StyleLandingChip nodeId={null} classIds={[rule.id]} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved in Plan.css')
    expect(screen.queryByTestId('style-landing-undo')).toBeNull()
  })

  it('rung 2: a side set under a shorthand says "as an override", and its Undo puts every byte back', async () => {
    const css = '.plan {\n  padding: 8px;\n  color: red;\n}\n'
    write('pages/Plan.tsx', PLAN_TSX)
    write('pages/Plan.css', css)
    const rule = planRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { paddingTop: '20px' })
    await save()

    expect(read('pages/Plan.css')).toBe('.plan {\n  padding: 8px;\n  padding-top: 20px;\n  color: red;\n}\n')
    render(<StyleLandingChip nodeId={null} classIds={[rule.id]} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toContain('Saved as an override in Plan.css')

    fireEvent.click(screen.getByTestId('style-landing-undo'))
    await waitFor(() => expect(read('pages/Plan.css')).toBe(css))
    // A restore is spent: the chip has nothing left to say about a write that was taken back.
    await waitFor(() => expect(screen.queryByTestId('style-landing-chip')).toBeNull())
  })

  it('a covering !important shorthand is expanded in place, says so, and Undo restores it', async () => {
    const css = '.plan {\n  padding: 4px 8px !important;\n}\n'
    write('pages/Plan.tsx', PLAN_TSX)
    write('pages/Plan.css', css)
    const rule = planRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { paddingTop: '20px' })
    await save()

    expect(read('pages/Plan.css')).toBe('.plan {\n  padding: 20px 8px 4px !important;\n}\n')
    render(<StyleLandingChip nodeId={null} classIds={[rule.id]} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toContain('Saved in Plan.css, shorthand expanded')

    fireEvent.click(screen.getByTestId('style-landing-undo'))
    await waitFor(() => expect(read('pages/Plan.css')).toBe(css))
  })

  it('no toast is raised for any of it — a refusal is gone, not hidden', async () => {
    write('pages/Plan.tsx', PLAN_TSX)
    write('pages/Plan.css', '.plan {\n  margin: 0 !important;\n}\n')
    const rule = planRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { marginLeft: '12px' })
    await save()

    expect(read('pages/Plan.css')).toBe('.plan {\n  margin: 0 0 0 12px !important;\n}\n')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('a class in a styled-components template', () => {
  const TOGGLE = `import styled from 'styled-components'

const GAP = '8px'

export const Toggle = styled.button\`
  padding: \${GAP};
  color: red;
\`

export default function Page() {
  return <Toggle>Go</Toggle>
}
`

  function toggleRule(loaded: Awaited<ReturnType<typeof openProject>>) {
    return Object.values(loaded.styleRules).find((rule) => rule.selector.startsWith('.Toggle_sc__'))!
  }

  it('an interpolated value is overridden after the interpolation, says so, and Undo restores the file', async () => {
    write('pages/Page.tsx', TOGGLE)
    const rule = toggleRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { padding: '20px' })
    await save()

    expect(read('pages/Page.tsx')).toContain('  padding: ${GAP};\n  color: red;\n  padding: 20px;\n')
    render(<StyleLandingChip nodeId={null} classIds={[rule.id]} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toContain('Saved as an override in Page.tsx')

    fireEvent.click(screen.getByTestId('style-landing-undo'))
    await waitFor(() => expect(read('pages/Page.tsx')).toBe(TOGGLE))
  })

  it('a literal is rewritten in place: "Saved in Page.tsx"', async () => {
    write('pages/Page.tsx', TOGGLE)
    const rule = toggleRule(await openProject())

    useEditorStore.getState().updateClassStyles(rule.id, { color: 'navy' })
    await save()

    expect(read('pages/Page.tsx')).toContain('  color: navy;\n')
    render(<StyleLandingChip nodeId={null} classIds={[rule.id]} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved in Page.tsx')
  })
})

describe('the element itself', () => {
  it('rung 3: an inline style says "Saved inline" and has no Undo (a value write takes it back)', async () => {
    write('pages/Plan.tsx', PLAN_TSX)
    write('pages/Plan.css', '.plan {\n  color: red;\n}\n')
    const loaded = await openProject()
    const page = loaded.pages[0]!
    const section = Object.values(page.nodes).find((node) => node.classIds.length > 0)!

    useEditorStore.getState().setNodeInlineStyles(section.id, { color: 'navy' })
    await save()

    expect(read('pages/Plan.tsx')).toMatch(/style=\{\{ color: ["']navy["'] \}\}/)
    render(<StyleLandingChip nodeId={section.id} classIds={section.classIds} />)
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved inline')
    expect(screen.queryByTestId('style-landing-undo')).toBeNull()
  })
})

describe('the chip at rest', () => {
  it('renders nothing until a write has landed', () => {
    render(<StyleLandingChip nodeId="pages/Plan.tsx:5:6" classIds={['sc-plan']} />)
    expect(screen.queryByTestId('style-landing-chip')).toBeNull()
  })
})
