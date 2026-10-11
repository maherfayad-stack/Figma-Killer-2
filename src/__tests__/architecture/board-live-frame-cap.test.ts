/**
 * Architecture Gate: the board has ONE live-frame policy (SB-5, poster-first).
 *
 * The cap on live iframes is the owner's decision (adaptive, default 20, never
 * below 12; posters below zoom 0.35). It holds only while there is exactly one
 * place that says so:
 *
 *  (a) `liveFrameCap.ts` is the only module that spells a live-frame count: the
 *      `LIVE_CAP_*` constants live there and nowhere else.
 *  (b) The pool this replaced is gone: no `framePool` module, no
 *      `MIN_FRAME_POOL` / `FRAME_POOL_HEADROOM` / `LIVE_FRAME_POOL_SIZE` /
 *      `nextFramePool` / `FrameMountCost` anywhere in `src/` or `tests/`.
 *  (c) `BoardFramesLayer` mounts through `selectLiveFrames`, and no board
 *      module keeps a second "recently seen" retention list of mounted frames.
 *  (d) `FrameMountReason` is exactly `live | poster | cold`.
 *
 * Comments are stripped first: explaining the rule is not a second copy of it.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const LAYER_DIR = 'src/admin/pages/site/canvas/BoardFramesLayer'
const CAP_MODULE = `${LAYER_DIR}/liveFrameCap.ts`

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function files(root: string, include: (rel: string) => boolean): { rel: string; code: string }[] {
  return [...walkSourceTree(join(REPO_ROOT, root))]
    .map((file) => ({ rel: toRepoRelativePosix(file), file }))
    .filter(({ rel }) => include(rel))
    .map(({ rel, file }) => ({ rel, code: withoutComments(readSource(file)) }))
}

const isTest = (rel: string) => rel.includes('/__tests__/') || /\.test\.tsx?$/.test(rel)

describe('board live-frame cap (SB-5)', () => {
  it('(a) spells the live-frame cap constants in exactly one module', () => {
    const offenders = files('src', (rel) => !isTest(rel))
      .filter(({ code }) => /\bexport\s+const\s+LIVE_CAP_[A-Z_]+\s*=/.test(code))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([CAP_MODULE])
  })

  it('(b) the old pool is gone', () => {
    expect(existsSync(join(REPO_ROOT, LAYER_DIR, 'framePool.ts'))).toBe(false)
    const banned = /\b(MIN_FRAME_POOL|FRAME_POOL_HEADROOM|LIVE_FRAME_POOL_SIZE|nextFramePool|sameFramePool|framePoolBudget|FrameMountCost)\b/
    const offenders = [...files('src', () => true), ...files('tests', () => true)]
      .filter(({ rel, code }) => rel !== 'src/__tests__/architecture/board-live-frame-cap.test.ts' && banned.test(code))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('(c) the layer mounts through selectLiveFrames and keeps no second retention list', () => {
    const layer = files(LAYER_DIR, (rel) => rel.endsWith('BoardFramesLayer.tsx')).find(({ rel }) => rel.endsWith('/BoardFramesLayer.tsx'))
    expect(layer, 'BoardFramesLayer.tsx not found').toBeDefined()
    expect(layer!.code).toContain('selectLiveFrames(')
    const retainers = files(LAYER_DIR, (rel) => !isTest(rel) && !rel.endsWith('liveFrameCap.ts'))
      .filter(({ code }) => /\b(pooledFrameIds|retention|FrameRetention|lastSeenFrames|warmFrames)\b/.test(code))
      .map(({ rel }) => rel)
    expect(retainers).toEqual([])
  })

  it('(d) FrameMountReason is live | poster | cold', () => {
    const source = withoutComments(readSource(join(REPO_ROOT, LAYER_DIR, 'frameMount.ts')))
    expect(source).toMatch(/export type FrameMountReason\s*=\s*'live'\s*\|\s*'poster'\s*\|\s*'cold'/)
  })
})
