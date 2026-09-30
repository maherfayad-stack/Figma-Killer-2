/**
 * `detachInstances` — P5-C (DET-5), the ONE Detach action, driven the whole
 * road with a stubbed network (the `structuralSourceUndo.test.ts` harness): a
 * real store action, a real `/save`, a narrow `/reload-scope`, a `/load`, and
 * a real `undo()` / `redo()`.
 *
 *   - a plain detach is instant: one `/save` (`dryRun: 'if-lossy'`), no
 *     confirm, one undo entry whose ⌘Z posts the journal's `restore`;
 *   - a detach that loses something is HELD by the server and confirmed
 *     first; Cancel writes nothing and pushes nothing;
 *   - a `.map` row detaches its template, and the confirm says every row (N);
 *   - a multi-selection is previewed once, confirmed once, written as ONE
 *     `sequence` bottom-up, and undone with ONE ⌘Z;
 *   - a refusal opens the refusal dialog with the duplicate remedy, aimed at
 *     the call site;
 *   - a package instance, a non-instance and a nested instance never post a
 *     detach of the id they were given (OD-7: the enclosing one goes first);
 *   - the button, both menus, the shortcut, the palette and the refusal
 *     remedy all reach this one action.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import '@modules/base'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'

const PAGE_ID = 'home'
const ROOT_ID = 'pages/Home.tsx:4:5'
const CARD_ID = 'pages/Home.tsx:5:7'
const TILE_ID = 'pages/Home.tsx:6:7'
const PKG_ID = 'pages/Home.tsx:7:7'
const LIST_ID = 'pages/Home.tsx:8:7'
const ROW_TEMPLATE = 'pages/Home.tsx:9:11'
const ROW_IDS = [`${ROW_TEMPLATE}#0`, `${ROW_TEMPLATE}#1`, `${ROW_TEMPLATE}#2`]
const NESTED_ID = `${CARD_ID}~components/Card.tsx:3:5`
const TEXT_ID = 'pages/Home.tsx:12:7'
/** Where a detach put the markup that replaced a call site. */
const MADE_ID = 'pages/Home.tsx:6:7'
const TOKEN_A = 'a'.repeat(32)
const TOKEN_B = 'b'.repeat(32)

interface DetachDetail {
  nodeId: string
  written: boolean
  lossy: boolean
  branchNote?: string
  movedHooks: string[]
  perRow: boolean
}

interface SaveAnswer {
  written?: number
  createdNodeIds?: string[]
  undoToken?: string
  refusals?: { nodeId: string; kind: string; reason: string; message: string }[]
  detachDetails?: DetachDetail[]
  pages?: Page[]
}

interface SaveBody {
  edits: Record<string, unknown>[]
  sequence?: boolean
}

function instance(id: string, componentName: string, source: 'local' | 'package' = 'local', children: string[] = []) {
  return makeNode({ id, moduleId: 'studio.instance', props: { componentName, source, sourceFile: `components/${componentName}.tsx`, callSiteProps: {} }, children })
}

function pageBefore(): Page {
  const nested = instance(NESTED_ID, 'Icon')
  const cardRoot = makeNode({ id: `${CARD_ID}~components/Card.tsx:2:10`, moduleId: 'base.container', children: [NESTED_ID] })
  return makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [CARD_ID, TILE_ID, PKG_ID, LIST_ID, TEXT_ID] }),
      [CARD_ID]: instance(CARD_ID, 'Card', 'local', [cardRoot.id]),
      [cardRoot.id]: cardRoot,
      [NESTED_ID]: nested,
      [TILE_ID]: instance(TILE_ID, 'Tile'),
      [PKG_ID]: instance(PKG_ID, 'Button', 'package'),
      [LIST_ID]: makeNode({ id: LIST_ID, moduleId: 'base.container', children: ROW_IDS }),
      ...Object.fromEntries(ROW_IDS.map((id) => [id, instance(id, 'Row')])),
      [TEXT_ID]: makeNode({ id: TEXT_ID, moduleId: 'base.text', props: { text: 'hi' } }),
    },
  })
}

/** The board after a detach: the markup at `MADE_ID`. */
function pageDetached(): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [MADE_ID] }),
      [MADE_ID]: makeNode({ id: MADE_ID, moduleId: 'base.container' }),
    },
  })
}

let originalFetch: typeof globalThis.fetch
let unregisterSave: (() => void) | null = null
let patchListener: ((evt: Event) => void) | null = null
let saveCalls: SaveBody[] = []

function stubFetch(answers: SaveAnswer[]): void {
  let call = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
    if (path === '/admin/api/studio/save') {
      saveCalls.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
      const answer = answers[Math.min(call, answers.length - 1)] ?? {}
      call += 1
      const written = answer.written ?? (answer.refusals ? 0 : 1)
      return new Response(
        JSON.stringify({
          ok: true,
          written,
          skipped: answer.refusals?.length ?? 0,
          refusals: answer.refusals ?? [],
          detachDetails: answer.detachDetails ?? [],
          shifted: written > 0,
          sharedComponents: false,
          touchedFiles: ['pages/Home.tsx'],
          createdNodeIds: answer.createdNodeIds ?? (written > 0 ? [MADE_ID] : []),
          relocatedNodeIds: [],
          removed: [],
          ...(answer.undoToken ? { undoToken: answer.undoToken } : {}),
        }),
        { status: 200 },
      )
    }
    if (path === '/admin/api/studio/reload-scope') {
      return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
    }
    if (path === '/admin/api/studio/load') {
      const answer = answers[Math.min(call - 1, answers.length - 1)] ?? {}
      const pages = answer.pages ?? [pageDetached()]
      const lines = [
        {
          kind: 'meta',
          dir: '/tmp/studio-test',
          projectName: 'studio-test',
          componentSources: {},
          styleRules: {},
          styleRuleSources: {},
          styledStyleRuleSources: {},
          conditions: [],
          vendorCss: '',
          authoredCss: '',
          trust: 'static',
          paletteHiddenModuleIds: [],
          pageList: pages.map(({ id, slug, title }) => ({ id, slug, title })),
        },
        ...pages.map((p, index) => ({ kind: 'page', page: p, index })),
      ]
      return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function currentToasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((toasts) => {
    snapshot = toasts
  })()
  return snapshot
}

const store = () => useEditorStore.getState()

beforeEach(() => {
  __resetToastBusForTests()
  resetStructuralCommitQueue()
  originalFetch = globalThis.fetch
  saveCalls = []
  unregisterSave = registerEditorSave(async () => {})
  setStudioLoadedDir('/tmp/studio-test')
  store().loadSite(makeSite({ pages: [pageBefore()] }))
  store().setActivePage(PAGE_ID)
  useEditorStore.setState({ structuralRefusalDialog: null, instanceDetachConfirm: null } as Parameters<typeof useEditorStore.setState>[0])
  patchListener = (evt: Event) => {
    applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
  }
  window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  unregisterSave?.()
  if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
  setStudioLoadedDir(null)
  resetStructuralCommitQueue()
  store().clearSite()
})

describe('detachInstances — one instance', () => {
  it('a plain detach is instant — one /save, no confirm — and ONE ⌘Z posts the journal restore; ⌘⇧Z detaches again', async () => {
    stubFetch([
      { undoToken: TOKEN_A, detachDetails: [{ nodeId: CARD_ID, written: true, lossy: false, movedHooks: [], perRow: false }] },
      { pages: [pageBefore()] },
      { undoToken: TOKEN_B },
    ])
    expect(await store().detachInstances([CARD_ID])).toBe('detached')
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0]!.edits).toEqual([{ kind: 'detach', nodeId: CARD_ID, dryRun: 'if-lossy' }])
    expect(store().instanceDetachConfirm).toBeNull()
    await waitFor(() => store().canUndo)
    // Selects what replaced the call site.
    await waitFor(() => store().selectedNodeIds.includes(MADE_ID))

    store().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'restore', nodeId: `undo-journal:${TOKEN_A}`, token: TOKEN_A }])
    await waitFor(() => store().canRedo)
    expect(store().canUndo).toBe(false)

    store().redo()
    await waitFor(() => saveCalls.length === 3)
    expect(saveCalls[2]!.edits).toEqual([{ kind: 'detach', nodeId: CARD_ID, dryRun: 'if-lossy' }])
  })

  it('a detach that loses other states is held, confirmed, then written — and is still ONE undo step', async () => {
    stubFetch([
      {
        written: 0,
        detachDetails: [{ nodeId: CARD_ID, written: false, lossy: true, branchNote: 'Card has more than one rendered state.', movedHooks: ['useLanguage'], perRow: false }],
      },
      { undoToken: TOKEN_A },
      { pages: [pageBefore()] },
    ])
    const outcome = store().detachInstances([CARD_ID])
    await waitFor(() => store().instanceDetachConfirm !== null)
    const confirm = store().instanceDetachConfirm!
    expect(confirm.title).toBe('Detach Card?')
    expect(confirm.losses).toEqual([
      'Card has more than one state; only the one on the canvas is kept.',
      'useLanguage() moves into the component around it.',
    ])
    expect(saveCalls).toHaveLength(1)

    store().resolveInstanceDetachConfirm(true)
    expect(await outcome).toBe('detached')
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'detach', nodeId: CARD_ID }])
    await waitFor(() => store().canUndo)

    store().undo()
    await waitFor(() => saveCalls.length === 3)
    expect(saveCalls[2]!.edits).toEqual([{ kind: 'restore', nodeId: `undo-journal:${TOKEN_A}`, token: TOKEN_A }])
    await waitFor(() => store().canRedo)
    expect(store().canUndo).toBe(false)
  })

  it('Cancel writes nothing and pushes nothing', async () => {
    stubFetch([{ written: 0, detachDetails: [{ nodeId: CARD_ID, written: false, lossy: true, movedHooks: ['useLanguage'], perRow: false }] }])
    const outcome = store().detachInstances([CARD_ID])
    await waitFor(() => store().instanceDetachConfirm !== null)
    store().resolveInstanceDetachConfirm(false)
    expect(await outcome).toBe('cancelled')
    expect(saveCalls).toHaveLength(1)
    expect(store().instanceDetachConfirm).toBeNull()
    expect(store().canUndo).toBe(false)
  })

  it('a `.map` row detaches its TEMPLATE, and the confirm says every row (N)', async () => {
    stubFetch([{ written: 0, detachDetails: [{ nodeId: ROW_TEMPLATE, written: false, lossy: true, movedHooks: [], perRow: true }] }])
    const outcome = store().detachInstances([ROW_IDS[2]!])
    await waitFor(() => store().instanceDetachConfirm !== null)
    expect(saveCalls[0]!.edits).toEqual([{ kind: 'detach', nodeId: ROW_TEMPLATE, dryRun: 'if-lossy' }])
    expect(store().instanceDetachConfirm!.losses).toEqual(['this changes every row of the list (3) — one piece of code renders them all.'])
    store().resolveInstanceDetachConfirm(false)
    expect(await outcome).toBe('cancelled')
  })

  it('a refusal opens the refusal dialog with the duplicate remedy, aimed at the call site', async () => {
    stubFetch([{ refusals: [{ nodeId: ROW_TEMPLATE, kind: 'detach', reason: 'uses-hooks', message: 'Row uses useState.' }] }])
    expect(await store().detachInstances([ROW_IDS[0]!])).toBe('refused')
    await waitFor(() => store().structuralRefusalDialog !== null)
    const dialog = store().structuralRefusalDialog!
    expect(dialog.title).toBe('Detach refused')
    expect(dialog.constraint.explanation).toBe('Row uses useState.')
    expect(dialog.constraint.actions.map((action) => action.kind)).toEqual(['extract'])
    expect(dialog.nodeId).toBe(ROW_TEMPLATE)
    expect(store().canUndo).toBe(false)
  })
})

describe('detachInstances — a multi-selection', () => {
  it('previews once, confirms once, writes ONE bottom-up sequence, and ONE ⌘Z restores it', async () => {
    stubFetch([
      {
        written: 0,
        detachDetails: [
          { nodeId: TILE_ID, written: false, lossy: false, movedHooks: [], perRow: false },
          { nodeId: CARD_ID, written: false, lossy: true, branchNote: 'x', movedHooks: [], perRow: false },
        ],
      },
      { undoToken: TOKEN_A, createdNodeIds: [MADE_ID, CARD_ID] },
      { pages: [pageBefore()] },
    ])
    const outcome = store().detachInstances([CARD_ID, TILE_ID])
    await waitFor(() => store().instanceDetachConfirm !== null)
    expect(saveCalls[0]!.edits).toEqual([
      { kind: 'detach', nodeId: TILE_ID, dryRun: 'always' },
      { kind: 'detach', nodeId: CARD_ID, dryRun: 'always' },
    ])
    expect(saveCalls[0]!.sequence).toBeUndefined()
    expect(store().instanceDetachConfirm).toEqual({
      title: 'Detach 2 instances?',
      losses: ['Card: Card has more than one state; only the one on the canvas is kept.'],
    })

    store().resolveInstanceDetachConfirm(true)
    expect(await outcome).toBe('detached')
    expect(saveCalls[1]!.sequence).toBe(true)
    expect(saveCalls[1]!.edits).toEqual([
      { kind: 'detach', nodeId: TILE_ID },
      { kind: 'detach', nodeId: CARD_ID },
    ])
    await waitFor(() => store().canUndo)

    store().undo()
    await waitFor(() => saveCalls.length === 3)
    expect(saveCalls[2]!.edits).toEqual([{ kind: 'restore', nodeId: `undo-journal:${TOKEN_A}`, token: TOKEN_A }])
    await waitFor(() => store().canRedo)
    expect(store().canUndo).toBe(false)
  })

  it('writes at once, with no confirm, when nothing in the selection loses anything', async () => {
    stubFetch([
      {
        written: 0,
        detachDetails: [
          { nodeId: TILE_ID, written: false, lossy: false, movedHooks: [], perRow: false },
          { nodeId: CARD_ID, written: false, lossy: false, movedHooks: [], perRow: false },
        ],
      },
      { undoToken: TOKEN_A },
    ])
    expect(await store().detachInstances([CARD_ID, TILE_ID])).toBe('detached')
    expect(saveCalls).toHaveLength(2)
    expect(saveCalls[1]!.sequence).toBe(true)
  })
})

describe('detachInstances — what it never posts', () => {
  it('ignores a selection with no instance in it', async () => {
    stubFetch([{}])
    expect(await store().detachInstances([TEXT_ID, ROOT_ID])).toBe('nothing')
    expect(saveCalls).toHaveLength(0)
  })

  it('refuses a package instance before posting anything', async () => {
    stubFetch([{}])
    expect(await store().detachInstances([PKG_ID])).toBe('refused')
    expect(saveCalls).toHaveLength(0)
    expect(currentToasts().some((toast) => toast.body?.includes('comes from a package'))).toBe(true)
  })

  it('never detaches a nested instance INTO the shared component file: the enclosing instance goes first (OD-7)', async () => {
    stubFetch([{ written: 0, refusals: [{ nodeId: CARD_ID, kind: 'detach', reason: 'uses-hooks', message: 'Card uses useState.' }] }])
    expect(await store().detachInstances([NESTED_ID])).toBe('handed-off')
    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits).toEqual([{ kind: 'detach', nodeId: CARD_ID }])
    // The enclosing one refused: no component copy is made for a detach, and nothing else is posted.
    await waitFor(() => currentToasts().some((toast) => toast.body?.includes('could not be detached')))
    expect(saveCalls.flatMap((call) => call.edits).some((edit) => edit.nodeId === NESTED_ID)).toBe(false)
  })
})

describe('one Detach action behind every surface', () => {
  const siteRoot = join(import.meta.dir, '..', '..', '..', '..')
  const read = (rel: string) => readFileSync(join(siteRoot, ...rel.split('/')), 'utf8')

  it('the button, both menus, ⌘⌥B, the palette and the refusal remedy call detachInstances', () => {
    expect(read('inspector/sections/ComponentSection.tsx')).toContain('detachInstances([nodeId])')
    // The canvas's right-click menu renders this same component.
    expect(read('canvas/CanvasLayerContextMenu.tsx')).toContain('<LayerNodeContextMenu')
    expect(read('panels/DomPanel/LayerNodeContextMenu.tsx')).toContain('detachInstances(targetIds)')
    expect(read('canvas/useCanvasLayerCommandKeys.ts')).toContain('detachInstances(state.selectedNodeIds)')
    expect(read('../../spotlight/commands/layerArrange.ts')).toContain('detachInstances(state.selectedNodeIds)')
    expect(read('store/constraintActions.ts')).toContain('context.detachInstances')
    expect(read('ui/ConstraintNotice/ConstraintActionButtons.tsx')).toContain('getState().detachInstances')
  })

  it('no surface posts a detach of its own: the old one-shot `detachInstance` is gone', () => {
    expect(read('studio/studioSaveRequests.ts')).not.toContain('export async function detachInstance(')
    for (const rel of ['inspector/sections/ComponentSection.tsx', 'store/constraintActions.ts', 'panels/DomPanel/LayerNodeContextMenu.tsx']) {
      expect(read(rel)).not.toContain("kind: 'detach'")
    }
  })
})
