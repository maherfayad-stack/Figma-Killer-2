/**
 * `studio_measure_element` — the three-step ritual and the name resolution, on
 * a real fixture project.
 *
 * Real: the workspace on disk, the board reconciliation
 * (`syncBoardFramesFromDisk`), the `loadStudioPages` parse, and the screen-name
 * matching. Faked: the headless browser (this environment cannot paint a DOM)
 * and the live-reload push (it needs an open editor stream).
 *
 * The point of the ritual assertions: an agent measuring a screen it JUST
 * wrote must not have to remember a board-placement call first, and it must
 * not measure the previous version of the file. `studio_screenshot` already
 * proved both are worth pinning; this tool shares them for the same reason.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBoardsFile } from '@core/studio-board'
import type { AgentFrameInspectRequest, AgentMeasureResult } from '@core/studio-capture'
import { createScaffoldedPage } from '../../../../handlers/studio/pageScaffold'

const MEASURE_RESULT: AgentMeasureResult = {
  kind: 'measure',
  pageId: 'placeholder',
  frame: { width: 1024, height: 800 },
  matched: 2,
  truncated: false,
  unmatched: [],
  elements: [{
    nodeId: 'card',
    tag: 'div',
    x: 24,
    y: 120,
    width: 320,
    height: 180,
    paddingPx: { top: 16, right: 16, bottom: 16, left: 16 },
    marginPx: { top: 0, right: 0, bottom: 8, left: 0 },
    borderPx: { top: 1, right: 1, bottom: 1, left: 1 },
    siblingAxis: 'block',
    gapAfterPx: 24,
    parent: {
      nodeId: 'list',
      tag: 'div',
      display: 'flex',
      flexDirection: 'column',
      rowGapPx: 16,
      columnGapPx: 16,
      paddingPx: { top: 0, right: 0, bottom: 0, left: 0 },
      rect: { x: 0, y: 0, width: 1024, height: 800 },
    },
  }],
}

let inspectCalls: AgentFrameInspectRequest[] = []
let reloadCalls: Array<Record<string, unknown>> = []
let headlessDown = false

mock.module('../../capture/headlessFrameInspect', () => ({
  inspectFrameHeadless: async (input: { request: AgentFrameInspectRequest }) => {
    inspectCalls.push(input.request)
    if (headlessDown) {
      return { ok: false, code: 'headless-browser-unavailable', error: 'No Chromium available in this test environment.' }
    }
    return { ok: true, result: { ...MEASURE_RESULT, pageId: input.request.pageId } }
  },
}))

// `mock.module` replaces the WHOLE module for every file in the same `bun test`
// run, so a factory that omits an export breaks any other suite importing it —
// `frameAxesTools.test.ts` imports the real `pushStudioLiveReload` through the
// tool under test. Both exports, always.
mock.module('./liveReloadPush', () => ({
  awaitStudioLiveReload: async (_userId: string, push: Record<string, unknown>) => { reloadCalls.push(push) },
  pushStudioLiveReload: (_userId: string, push: Record<string, unknown>) => { reloadCalls.push(push) },
  STUDIO_LIVE_RELOAD_TOOL_NAME: 'studio_live_reload',
}))

const { studioMeasureElementMcpTools } = await import('./measureElement')
const tool = studioMeasureElementMcpTools.find((t) => t.name === 'studio_measure_element')!

let dir: string

function ctx() {
  return {
    userId: 'u1',
    capabilities: [],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    db: undefined,
  } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-measure-element-'))
  createScaffoldedPage(dir, 'Checkout')
  inspectCalls = []
  reloadCalls = []
  headlessDown = false
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('studio_measure_element', () => {
  it('resolves a screen by NAME, not only by page id', async () => {
    for (const name of ['Checkout', 'Checkout.tsx', 'pages/Checkout.tsx']) {
      inspectCalls = []
      const out = (await tool.handler!({ dir, page: name }, ctx())) as { ok: boolean }
      expect(out.ok).toBe(true)
      expect(inspectCalls).toHaveLength(1)
      expect(inspectCalls[0]!.pageId).toBe('checkout')
    }
  })

  it('places the board frame and waits for the parse BEFORE measuring — the whole ritual, in one call', async () => {
    // Model the case this step exists for: a screen the agent wrote itself
    // with `Write`, which places no board frame at all. The scaffolder used in
    // `beforeEach` DOES place one, so drop it.
    rmSync(join(dir, '.studio', 'boards.json'), { force: true })
    expect(existsSync(join(dir, '.studio', 'boards.json'))).toBe(false)

    const out = (await tool.handler!({ dir, page: 'Checkout' }, ctx())) as {
      ok: boolean
      data: { newlyPlacedOnBoard?: string[] }
    }
    expect(out.ok).toBe(true)
    expect(out.data.newlyPlacedOnBoard).toEqual(['checkout'])

    const boards = parseBoardsFile(readFileSync(join(dir, '.studio', 'boards.json'), 'utf8'))
    expect(boards.boards[0]!.frames.map((f) => f.pageId)).toEqual(['checkout'])
    // Awaited before the measurement, so what comes back is the file as it is
    // NOW rather than the previous parse of it.
    expect(reloadCalls).toHaveLength(1)
    expect(reloadCalls[0]).toMatchObject({ dir, pageIds: ['checkout'], boardsChanged: true })
  })

  it('forwards nodeIds, selector and limit to the frame read verbatim', async () => {
    await tool.handler!(
      { dir, page: 'Checkout', nodeIds: ['card'], selector: '.row', limit: 5 },
      ctx(),
    )
    expect(inspectCalls[0]).toEqual({
      kind: 'measure',
      pageId: 'checkout',
      nodeIds: ['card'],
      selector: '.row',
      limit: 5,
    })
  })

  it('omits absent optionals rather than sending explicit undefineds', async () => {
    await tool.handler!({ dir, page: 'Checkout' }, ctx())
    expect(inspectCalls[0]).toEqual({ kind: 'measure', pageId: 'checkout' })
  })

  it('returns the measured geometry with the parent\'s declared gap beside it', async () => {
    const out = (await tool.handler!({ dir, page: 'Checkout' }, ctx())) as {
      ok: boolean
      data: AgentMeasureResult & { dir: string; page: string }
    }
    expect(out.data.page).toBe('Checkout')
    expect(out.data.dir).toBe(dir)
    const card = out.data.elements[0]!
    // The whole diagnosis in one row: measured 24 against a declared 16 means a
    // margin is in play, which is exactly what a screenshot cannot show.
    expect(card.gapAfterPx).toBe(24)
    expect(card.parent?.rowGapPx).toBe(16)
    expect(card.marginPx.bottom).toBe(8)
  })

  it('names the screens it does know when nothing matches', async () => {
    const out = (await tool.handler!({ dir, page: 'Nowhere' }, ctx())) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Nowhere')
    expect(out.error).toContain('Checkout')
    expect(inspectCalls).toEqual([])
  })

  it('says the headless browser is the requirement when it cannot run — there is no tab fallback here', async () => {
    headlessDown = true
    const out = (await tool.handler!({ dir, page: 'Checkout' }, ctx())) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('measure-unavailable')
    expect(out.error).toContain('playwright install chromium')
  })
})
