/**
 * The large board corpus — 40 frames × ~300 elements (audit `01-perf.md` §3
 * item 2, ROADMAP P2-A).
 *
 * Every other canvas budget runs on `__board-perf-fixture` (12 frames × ~28
 * elements) or `test4` (3 frames). At that size the per-node costs the audit
 * measured — the selector sweep (PERF-1), the frame-fit passes a hover used to
 * trigger (PERF-2) — are sub-millisecond, so no gate could see them. This
 * board is the size the audit named, so the hover-sweep, pan-with-selection
 * and idle-rAF budgets in `canvas-feel-budgets.e2e.ts` measure a board where
 * those costs are real.
 *
 * **Generated, never committed.** 40 × 300 elements is ~1 MB of `.tsx`; it is
 * written into this run's throwaway workspace copy (`WORKSPACE_ROOT`) by
 * `createAuthoredFixtureProject`, which is also the one path the server's
 * project-containment check accepts. The generator is deterministic, so two
 * runs measure the same board.
 *
 * **Tier 0 on purpose** (`"trust": "static"`): no `package.json`, no bridge
 * frame, every frame a portal `srcdoc` iframe. The budgets are about the
 * portal canvas — the default for every project Studio cannot run.
 *
 * Shape of one screen: a header plus `SECTIONS_PER_SCREEN` sections, each a
 * heading, a paragraph and a list of `ITEMS_PER_SECTION` two-span items —
 * 1 + 3 + 9 × (4 + 10 × 3) = 310 elements. Frames hug their content (no stored
 * height), and the grid's row pitch leaves room for the tallest screen.
 */
import { createAuthoredFixtureProject, type FixtureProject } from './studioFixtureProject'

export const LARGE_BOARD_CORPUS_NAME = '__large-board-corpus'
export const LARGE_BOARD_FRAME_COUNT = 40
const SECTIONS_PER_SCREEN = 9
const ITEMS_PER_SECTION = 10
const FRAMES_PER_ROW = 5
const FRAME_WIDTH = 1024
const COLUMN_PITCH = FRAME_WIDTH + 80
/** A screen renders ~2,550 px tall (measured on `canvas-feel-budgets.e2e.ts`'s first run); 3,000 keeps rows apart. */
const ROW_PITCH = 3000

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']

function screenName(index: number): string {
  return `Screen${String(index + 1).padStart(2, '0')}`
}

/** The page id Studio derives from `pages/ScreenNN.tsx` — the same rule `__board-perf-fixture`'s `boards.json` relies on. */
export function largeBoardPageId(index: number): string {
  return screenName(index).toLowerCase()
}

function screenSource(index: number): string {
  const sections: string[] = []
  for (let s = 0; s < SECTIONS_PER_SCREEN; s += 1) {
    const items: string[] = []
    for (let i = 0; i < ITEMS_PER_SECTION; i += 1) {
      const word = WORDS[(index + s + i) % WORDS.length]
      items.push(
        `          <li className="row">\n` +
          `            <span className="row__label">${word} ${s + 1}.${i + 1}</span>\n` +
          `            <span className="row__value">${(index * 37 + s * 11 + i * 7) % 100}</span>\n` +
          `          </li>`,
      )
    }
    sections.push(
      `      <section className="block">\n` +
        `        <h2 className="block__heading">Section ${s + 1} of screen ${index + 1}</h2>\n` +
        `        <p className="block__body">Rows of the same shape, so every frame on this board costs the same to mount, hover and measure.</p>\n` +
        `        <ul className="block__rows">\n${items.join('\n')}\n        </ul>\n` +
        `      </section>`,
    )
  }
  return (
    `import './corpus.css'\n\n` +
    `export default function ${screenName(index)}() {\n` +
    `  return (\n` +
    `    <main className="screen">\n` +
    `      <header className="screen__bar">\n` +
    `        <span className="screen__title">Screen ${index + 1}</span>\n` +
    `        <span className="screen__badge">Frame ${index + 1} of ${LARGE_BOARD_FRAME_COUNT}</span>\n` +
    `      </header>\n` +
    `${sections.join('\n')}\n` +
    `    </main>\n` +
    `  )\n` +
    `}\n`
  )
}

const CORPUS_CSS = `.screen { font-family: system-ui, sans-serif; padding: 24px; color: #1d2330; background: #f6f7fb; }
.screen__bar { display: flex; justify-content: space-between; padding: 12px 16px; background: #fff; border-radius: 8px; }
.screen__title { font-weight: 600; }
.screen__badge { color: #5b6477; }
.block { margin-top: 16px; padding: 16px; background: #fff; border-radius: 8px; }
.block__heading { margin: 0 0 8px; font-size: 18px; }
.block__body { margin: 0 0 12px; color: #5b6477; }
.block__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; margin: 0; padding: 0; list-style: none; }
.row { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: 6px; background: #eef1f7; }
.row__label { text-transform: capitalize; }
.row__value { font-variant-numeric: tabular-nums; color: #3a4356; }
`

export function writeLargeBoardCorpus(): FixtureProject {
  const files: Record<string, string> = {
    '.studio/meta.json': JSON.stringify(
      {
        // Sorts after every real project and after the other `__` fixtures, so
        // it never becomes the workspace's default project.
        displayName: 'Zz Large Board Corpus',
        platform: 'web',
        pagesDir: 'pages',
        trust: 'static',
        frameDefaults: { width: FRAME_WIDTH, height: 800 },
      },
      null,
      2,
    ),
    '.studio/boards.json': JSON.stringify(
      {
        version: 1,
        boards: [
          {
            id: 'lbc-board-1',
            name: 'Large',
            frames: Array.from({ length: LARGE_BOARD_FRAME_COUNT }, (_, index) => ({
              id: `lbc-frame-${String(index + 1).padStart(2, '0')}`,
              pageId: largeBoardPageId(index),
              x: (index % FRAMES_PER_ROW) * COLUMN_PITCH,
              y: Math.floor(index / FRAMES_PER_ROW) * ROW_PITCH,
              width: FRAME_WIDTH,
            })),
            notes: [],
            docs: [],
            guides: [],
          },
        ],
      },
      null,
      2,
    ),
    'pages/corpus.css': CORPUS_CSS,
  }
  for (let index = 0; index < LARGE_BOARD_FRAME_COUNT; index += 1) {
    files[`pages/${screenName(index)}.tsx`] = screenSource(index)
  }
  return createAuthoredFixtureProject(LARGE_BOARD_CORPUS_NAME, files)
}
