/**
 * Every `select*` in `commentSelectors.ts` must return a STORED reference or a
 * primitive — never a value it just built.
 *
 * This gate exists because the alternative shipped. `selectVisibleThreads`
 * filtered inside the selector, so `useEditorStore(selectVisibleThreads)` handed
 * React a new array on every snapshot read: React re-rendered to catch up, read
 * again, got another new array, and looped until it bailed with "Maximum update
 * depth exceeded" — taking down the whole site-editor-body error boundary. The
 * trigger was one comment existing in the project, so every gate stayed green
 * and it only appeared under a real reviewer with a real thread on screen.
 *
 * Two checks, because either alone is easy to slip past:
 *
 *   1. A source rule — a `select*` binding may not contain an array-building
 *      call. Catches a new selector nobody wired up yet.
 *   2. A behavioural rule — call every single-argument selector twice against
 *      an unchanged store and require the results to be `===`. Catches a
 *      selector that builds a value some other way.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useEditorStore } from '@site/store/store'
import * as commentSelectors from '@site/store/slices/commentSelectors'
import { createCommentsFile, createThread, type CommentsFile } from '@core/studio-comments'

const SELECTORS_PATH = join(
  import.meta.dir,
  '../../admin/pages/site/store/slices/commentSelectors.ts',
)

/** `.filter(`, `.map(`, `.slice(`, `.concat(`, `.sort(` — anything that mints an array. */
const ARRAY_BUILDERS = /\.(filter|map|flatMap|slice|concat|sort|reverse|toSorted)\(/

describe('comment selectors return stored references', () => {
  it('no exported `select*` builds an array in its body', () => {
    const source = readFileSync(SELECTORS_PATH, 'utf8')
    // Split on top-level export boundaries; a selector's body is everything up
    // to the next export.
    const chunks = source.split(/\nexport (?:const|function) /).slice(1)
    const offenders = chunks
      .filter((chunk) => /^select[A-Z]/.test(chunk))
      .filter((chunk) => ARRAY_BUILDERS.test(chunk.split('\n\nexport')[0] ?? chunk))
      .map((chunk) => chunk.slice(0, chunk.indexOf('(')))

    expect(offenders).toEqual([])
  })

  it('every state-only selector is referentially stable across repeat reads', () => {
    const withThreads: CommentsFile = createThread(createCommentsFile(), {
      id: 't1',
      commentId: 'c1',
      boardId: 'b1',
      anchor: { frameId: 'f1', pageId: 'home', dx: 1, dy: 2, node: null },
      author: { userId: 'u1', displayName: 'Maher', kind: 'user' },
      body: 'the one comment that used to hang the editor',
      now: '2026-08-31T12:00:00.000Z',
    })!

    useEditorStore.setState({
      comments: withThreads,
      commentsLoaded: true,
      commentsLoadFailed: false,
      commentToolActive: false,
      activeThreadId: 't1',
      draftPin: null,
      commentFilter: 'open',
      commentSearch: '',
    })

    const entries = Object.entries(commentSelectors).filter(
      (entry): entry is [string, (s: unknown) => unknown] =>
        entry[0].startsWith('select') && typeof entry[1] === 'function' && entry[1].length === 1,
    )
    expect(entries.length).toBeGreaterThan(0)

    const state = useEditorStore.getState()
    for (const [name, selector] of entries) {
      expect(
        selector(state) === selector(state) ? `${name}: stable` : `${name}: NEW REFERENCE`,
      ).toBe(`${name}: stable`)
    }
  })
})
