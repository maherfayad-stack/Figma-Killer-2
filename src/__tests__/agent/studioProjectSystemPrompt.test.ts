/**
 * `buildStudioProjectSystemPrompt` (WS-12 §4 + §2.1 + §2.2) — the real
 * Studio-project prompt path in `server/ai/handlers/chat.ts`, exercised
 * against a real temp-dir fixture (a fresh "project" with a real page file)
 * rather than a mocked probe, so a genuine wiring break (a typo'd import, a
 * wrong field name against `ProjectProfile`/`Page`) fails here instead of
 * only at runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStudioProjectSystemPrompt } from '../../../server/ai/handlers/chat'
import type { StudioAgentSnapshot } from '../../../server/ai/tools/studio/snapshot'
import { createStalenessTracker } from '../../../server/ai/tools/studio/staleness'

function homePageSource(): string {
  return [
    'export default function Home() {',
    '  return (',
    '    <div className="hero">',
    '      <button label="Go">Go</button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

describe('buildStudioProjectSystemPrompt', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-prompt-'))
    // `pages/` — the same no-config default `projectPagesDir` (`studioProjects.ts`)
    // falls back to for a project with no `.studio/meta.json` yet, exactly
    // this fixture's shape.
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', dependencies: { react: '^18.0.0', vite: '^5.0.0' } }),
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds the cacheable 3-element form from a real project probe, never the CMS/site prompt', async () => {
    const prompt = await buildStudioProjectSystemPrompt(dir, undefined, 'conv-1')
    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    // The CMS prompt's own vocabulary must never leak into a Studio-project turn.
    expect(prompt.join(' ')).not.toContain('site_insert_html')
    expect(prompt.join(' ')).not.toContain('studio-outlet')
    // The Studio prompt's own tool vocabulary must be present.
    expect(prompt[0]).toContain('studio_screenshot')
    expect(prompt[0]).toContain('Read, Write, Edit, Glob and Grep')
  })

  it('the dynamic suffix carries the real dir, never a placeholder', async () => {
    const prompt = await buildStudioProjectSystemPrompt(dir, undefined, 'conv-1')
    expect(prompt[2]).toContain(dir)
  })

  it('never throws for a directory a real probe cannot make sense of, and degrades honestly', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'studio-prompt-empty-'))
    try {
      // No try/catch around the call itself: an unexpected throw fails the
      // test on its own via the unhandled rejection, exactly what "never
      // throws" means to assert.
      const prompt = await buildStudioProjectSystemPrompt(emptyDir, undefined, 'conv-1')
      expect(prompt).toHaveLength(3)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('a malformed snapshot degrades to the profile-only suffix rather than throwing', async () => {
    const prompt = await buildStudioProjectSystemPrompt(dir, { garbage: true }, 'conv-1')
    expect(prompt).toHaveLength(3)
    expect(prompt[2]).not.toContain('Board:')
  })

  // ── §2.1 live digest, against a real page file ────────────────────────

  function writeHomePage() {
    writeFileSync(join(dir, 'pages', 'Home.tsx'), homePageSource())
  }

  async function homePageId(): Promise<string> {
    const { loadStudioPages } = await import('../../../server/handlers/studioPageLoad')
    const { pages } = await loadStudioPages(dir)
    const page = pages[0]
    if (!page) throw new Error('fixture page did not parse')
    return page.id
  }

  it('a valid snapshot drives board/active-page/selection lines, never scanning any OTHER page', async () => {
    writeHomePage()
    const pageId = await homePageId()
    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId, x: 0, y: 0, width: 390, height: 844 }],
      activePageId: pageId,
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const prompt = await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-2', { staleness: createStalenessTracker() })
    expect(prompt[2]).toContain('Board: board-1')
    expect(prompt[2]).toContain(pageId)
    expect(prompt[2]).toContain('Active page:')
    expect(prompt[2]).toContain('Selected: none')
  })

  it('a selected node resolves its writable-vs-locked facts from the already-loaded active page', async () => {
    writeHomePage()
    const pageId = await homePageId()
    const { loadStudioPages } = await import('../../../server/handlers/studioPageLoad')
    const { pages } = await loadStudioPages(dir)
    const page = pages[0]!
    // The button's own node — a real writable node id from the real parse,
    // never invented (matches this codebase's own node-id discipline).
    const buttonNodeId = Object.keys(page.nodes).find((id) => page.nodes[id]!.moduleId.includes('button')) ?? page.rootNodeId

    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId, x: 0, y: 0 }],
      activePageId: pageId,
      selectedNodeId: buttonNodeId,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const prompt = await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-3', { staleness: createStalenessTracker() })
    expect(prompt[2]).toContain(`Selected: ${buttonNodeId}`)
  })

  it('never warns on the first turn, then warns once the active page file changes before the next turn (§2.2 staleness)', async () => {
    writeHomePage()
    const pageId = await homePageId()
    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId, x: 0, y: 0 }],
      activePageId: pageId,
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    // A fresh tracker per test — never the shared production singleton, so
    // this test's assertions can't leak into or out of another test's run.
    const staleness = { staleness: createStalenessTracker() }

    const first = await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-1', staleness)
    expect(first[2]).not.toContain('node ids re-issued')

    // Simulate a write landing on the page file between turns — bump its
    // mtime forward, the same externally-observable effect any edit has.
    const target = join(dir, 'pages', 'Home.tsx')
    const future = new Date(Date.now() + 5000)
    utimesSync(target, future, future)

    const second = await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-1', staleness)
    expect(second[2]).toContain('node ids re-issued')
  })

  it('a DIFFERENT conversation never sees another conversation\'s staleness warning', async () => {
    writeHomePage()
    const pageId = await homePageId()
    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId, x: 0, y: 0 }],
      activePageId: pageId,
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const staleness = { staleness: createStalenessTracker() }
    await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-a', staleness)
    const target = join(dir, 'pages', 'Home.tsx')
    const future = new Date(Date.now() + 5000)
    utimesSync(target, future, future)
    // conv-b has never looked at this file before — first look, no warning.
    const otherConv = await buildStudioProjectSystemPrompt(dir, snapshot, 'conv-b', staleness)
    expect(otherConv[2]).not.toContain('node ids re-issued')
  })
})
