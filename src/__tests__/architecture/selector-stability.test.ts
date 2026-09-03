/**
 * A zustand selector must return something ALREADY IN THE STORE — a stored
 * reference or a primitive — never a value it just built.
 *
 * This gate exists because the alternative has now shipped TWICE, and both
 * times it took the whole editor down with "Maximum update depth exceeded"
 * before the canvas could mount:
 *
 *   1. `selectVisibleThreads` filtered inside the selector, so
 *      `useEditorStore(selectVisibleThreads)` handed React a new array on every
 *      snapshot read. React re-rendered to catch up, read again, got another
 *      new array, and looped. The trigger was ONE comment existing, so every
 *      gate stayed green until a real reviewer had a real thread on screen.
 *   2. `selectVisibleLinks` merged authored and code-derived prototype links
 *      inside the selector, and `selectLinkSource` returned a fresh
 *      `{ confidence, nodeId, live }`. Same loop, and the first version of this
 *      gate could not see it because it only ever looked at `commentSelectors`.
 *
 * So the rule is no longer about comments. Three checks:
 *
 *   1. SOURCE — no exported `select*` in any `*Selectors.ts` may build an array
 *      or return an object literal. Catches a new selector nobody wired up yet.
 *   2. BEHAVIOUR — call every single-argument `select*` twice against an
 *      unchanged store and require `===`. Catches one that builds a value some
 *      other way.
 *   3. CALL SITE — `useEditorStore((s) => helper(s, …))` is the shape that hides
 *      an unstable return behind a multi-argument helper the behavioural check
 *      cannot invoke. Every such helper is listed below with the reason it is
 *      stable, so adding one is the moment you have to check.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { useEditorStore } from '@site/store/store'
import * as commentSelectors from '@site/store/slices/commentSelectors'
import * as boardSelectors from '@site/store/slices/boardSelectors'
import { createCommentsFile, createThread, type CommentsFile } from '@core/studio-comments'

const SRC_ROOT = join(import.meta.dir, '../..')
const SLICES_DIR = join(SRC_ROOT, 'admin/pages/site/store/slices')

function collectSourceFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectSourceFiles(full))
    } else if (extname(entry) === '.ts' || extname(entry) === '.tsx') {
      results.push(full)
    }
  }
  return results
}

function relPath(file: string): string {
  return relative(SRC_ROOT, file).split('\\').join('/')
}

/** `.filter(`, `.map(`, `.slice(` — anything that mints an array. */
const ARRAY_BUILDERS = /\.(filter|map|flatMap|slice|concat|sort|reverse|toSorted|toReversed)\(/
/** `=> ({ … })` or `return { … }` — anything that mints an object. */
const OBJECT_BUILDERS = /=>\s*\(\s*\{|return\s*\{/

/**
 * Multi-argument helpers that MAY be called inside an inline
 * `useEditorStore((s) => …)`, each with the reason its return is stable.
 *
 * Adding a name here is a claim that the helper returns a stored reference or a
 * primitive. Check it before you add it — the failure mode is not a wrong
 * value, it is the editor refusing to mount.
 */
const STABLE_INLINE_SELECTOR_HELPERS: ReadonlyMap<string, string> = new Map([
  ['selectCanvasPageFor', 'returns the stored Page object, or a field read off it'],
  ['selectActiveCanvasPage', 'returns the stored Page object'],
  ['selectThreadAnchorConfidence', 'returns a string literal union'],
  ['resolveEditorFormPreviewState', 'returns a stored slice of preview state'],
  ['resolveEditorFormPreviewSuccessMessage', 'returns a string'],
  ['findNodeById', 'returns the stored node object'],
])

function selectorModulePaths(): string[] {
  return readdirSync(SLICES_DIR)
    .filter((name) => name.endsWith('Selectors.ts'))
    .map((name) => join(SLICES_DIR, name))
}

describe('selectors return stored references', () => {
  it('covers every *Selectors.ts module, not just one of them', () => {
    // The first version of this gate hard-coded `commentSelectors.ts`, which is
    // why the identical bug shipped again in `prototypeSelectors.ts`.
    const names = selectorModulePaths().map((path) => path.split('/').pop())
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names).toContain('commentSelectors.ts')
    expect(names).toContain('prototypeSelectors.ts')
  })

  it('no exported `select*` builds an array or an object in its body', () => {
    const offenders: string[] = []

    for (const path of selectorModulePaths()) {
      const source = readFileSync(path, 'utf8')
      const moduleName = path.split('/').pop() ?? path
      // Split on top-level export boundaries; a selector's body is everything
      // up to the next export.
      const chunks = source.split(/\nexport (?:const|function) /).slice(1)
      for (const chunk of chunks) {
        if (!/^select[A-Z]/.test(chunk)) continue
        const body = chunk.split('\n\nexport')[0] ?? chunk
        if (ARRAY_BUILDERS.test(body) || OBJECT_BUILDERS.test(body)) {
          offenders.push(`${moduleName}: ${chunk.slice(0, chunk.search(/[(<:]/))}`)
        }
      }
    }

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

    const entries = Object.entries({ ...commentSelectors, ...boardSelectors }).filter(
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

  it('every helper called inside an inline useEditorStore selector is listed as stable', () => {
    const pattern = /useEditorStore\(\(s\) => ([a-zA-Z_][\w]*)\(s[,)]/g
    const offenders: string[] = []

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(pattern)) {
        const helper = match[1]!
        if (!STABLE_INLINE_SELECTOR_HELPERS.has(helper)) {
          offenders.push(`${relPath(file)}: ${helper}`)
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `[selector-stability] Inline useEditorStore selector delegates to an unlisted helper:\n` +
          offenders.map((entry) => `  ${entry}`).join('\n') +
          `\n\nA helper called with the store inside useEditorStore must return a STORED ` +
          `reference or a primitive. If it builds an array or object, React loops until it ` +
          `bails with "Maximum update depth exceeded" and the editor never mounts. Either read ` +
          `stable state and derive in the render body, or add the helper to ` +
          `STABLE_INLINE_SELECTOR_HELPERS in this file with the reason it is stable.`,
      )
    }
    expect(offenders).toEqual([])
  })
})
