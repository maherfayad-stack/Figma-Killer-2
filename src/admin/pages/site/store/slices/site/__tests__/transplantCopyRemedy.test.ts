/**
 * D2 G3 — "Duplicate into frame instead", end to end through the store.
 *
 * The rule that offers the remedy is pinned in `transplantPlan.test.ts` and
 * `sourceStructureTransplant.test.ts`. What this file pins is the part a rule
 * test cannot see: that pressing the button actually does something, and that
 * what it does is K2's copy across frames — **one write, one toast**, through
 * the same store action, the same concurrency guard and the same gate the
 * original drag went through. A remedy that opened a second code path would be
 * a second way of doing the same thing, which is exactly what makes remedies
 * rot.
 *
 * The network is stubbed at `globalThis.fetch` — restorable, unlike
 * `mock.module`, which is process-global and permanent (`standing-01`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { resolveConstraintAction } from '@site/store/constraintActions'
import { subscribeToasts } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'
import '@modules/base/index'

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
/** Markup inlined from a shared component — the commonest cross-frame refusal. */
const HOME_BADGE = 'pages/Home.tsx:6:7~ui/Badge.tsx:3:3'
/** A `.map` row — a refusal a copy shares, so the remedy must stay off it. */
const HOME_ROW = 'pages/Home.tsx:9:7#2'
const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'

const realFetch = globalThis.fetch
let posted: { edits: Record<string, unknown>[] }[] = []

function stubSaveRoute(): void {
  posted = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/save')) {
      posted.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(
        JSON.stringify({
          ok: true,
          written: 1,
          skipped: 0,
          shifted: true,
          sharedComponents: false,
          touchedFiles: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function seedSite(extraHomeChild?: string): void {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          title: 'Home',
          rootNodeId: HOME_ROOT,
          nodes: {
            [HOME_ROOT]: makeNode({ id: HOME_ROOT, moduleId: 'base.container', children: [HOME_MAIN] }),
            [HOME_MAIN]: makeNode({
              id: HOME_MAIN,
              moduleId: 'base.container',
              children: extraHomeChild ? [HOME_BADGE, extraHomeChild] : [HOME_BADGE],
              parentId: HOME_ROOT,
            }),
            [HOME_BADGE]: makeNode({ id: HOME_BADGE, moduleId: 'base.text', parentId: HOME_MAIN }),
            ...(extraHomeChild
              ? { [extraHomeChild]: makeNode({ id: extraHomeChild, moduleId: 'base.text', parentId: HOME_MAIN }) }
              : {}),
          },
        }),
        makePage({
          id: 'about',
          slug: 'about',
          title: 'About',
          rootNodeId: ABOUT_ROOT,
          nodes: {
            [ABOUT_ROOT]: makeNode({ id: ABOUT_ROOT, moduleId: 'base.container', children: [ABOUT_MAIN] }),
            [ABOUT_MAIN]: makeNode({
              id: ABOUT_MAIN,
              moduleId: 'base.container',
              children: [ABOUT_H1],
              parentId: ABOUT_ROOT,
            }),
            [ABOUT_H1]: makeNode({ id: ABOUT_H1, moduleId: 'base.text', parentId: ABOUT_MAIN }),
          },
        }),
      ],
    }),
  )
  useEditorStore.setState({
    activePageId: 'home',
    structuralRefusalDialog: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const DESTINATION = { originPageId: 'home', pageId: 'about', parentId: ABOUT_MAIN, index: 0 }

beforeEach(() => {
  stubSaveRoute()
  seedSite()
})

afterEach(() => {
  globalThis.fetch = realFetch
  useEditorStore.setState({ structuralRefusalDialog: null } as Parameters<typeof useEditorStore.setState>[0])
})

describe('the cross-frame copy remedy', () => {
  it('opens the refusal dialog with a runnable handler, and writes nothing yet', () => {
    useEditorStore.getState().transplantNodes([HOME_BADGE], DESTINATION)

    const dialog = useEditorStore.getState().structuralRefusalDialog
    expect(dialog?.constraint.reason).toBe('shared-component')
    expect(typeof dialog?.duplicateIntoFrame).toBe('function')
    expect(posted).toHaveLength(0)
  })

  it('runs K2’s copy across frames when the button is pressed, as ONE write', async () => {
    useEditorStore.getState().transplantNodes([HOME_BADGE], DESTINATION)
    const dialog = useEditorStore.getState().structuralRefusalDialog
    const action = dialog?.constraint.actions.find((entry) => entry.kind === 'duplicate-into-frame')
    expect(action).toBeDefined()

    // The exact dispatch `ConstraintActionButtons` performs — the remedy is
    // only real if it survives the one table every constraint action goes
    // through.
    const run = resolveConstraintAction(action!, {
      nodeId: dialog?.nodeId,
      ...(dialog?.duplicateIntoFrame ? { duplicateIntoFrame: dialog.duplicateIntoFrame } : {}),
    })
    expect(run).not.toBeNull()
    run!()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(posted).toHaveLength(1)
    const edits = posted[0]!.edits
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({
      kind: 'transplant',
      nodeId: HOME_BADGE,
      parentNodeId: ABOUT_MAIN,
      copy: true,
    })
  })

  it('lands no toast for the whole remedy — the copy on the destination frame is the answer (P3-A)', async () => {
    const seen: string[] = []
    const unsubscribe = subscribeToasts((items) => {
      for (const item of items) if (item.title && !seen.includes(item.title)) seen.push(item.title)
    })
    try {
      useEditorStore.getState().transplantNodes([HOME_BADGE], DESTINATION)
      // The refusal itself is a DIALOG, not a toast — `presentStructuralRefusal`
      // routes anything with a runnable action there.
      expect(seen).toHaveLength(0)

      useEditorStore.getState().structuralRefusalDialog?.duplicateIntoFrame?.()
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(seen).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('does not offer the remedy for a refusal a copy shares', () => {
    seedSite(HOME_ROW)
    useEditorStore.getState().transplantNodes([HOME_ROW], DESTINATION)
    const dialog = useEditorStore.getState().structuralRefusalDialog
    // `list-row` has its own remedy (open the array), so a dialog still opens —
    // it just has no copy button, because a copy could not read the row either.
    expect(dialog?.constraint.actions.some((entry) => entry.kind === 'duplicate-into-frame')).toBe(false)
    expect(dialog?.duplicateIntoFrame).toBeUndefined()
  })
})
