/**
 * A Tier-2 project whose live frames REALLY boot inside an e2e run, with a
 * page that animates from JavaScript — ROADMAP P6-C, audit `01-perf.md` §3
 * item 13 (PERF-9), and the first real measurement for
 * `docs/audits/2026-09-13-live-frame-memory-baseline.md`.
 *
 * ## Why every other Tier-2 fixture stays on its static fallback
 *
 * Studio runs a project's OWN Vite (`viteLaunch.ts`): `node_modules/vite`
 * found from the app root up to the project directory and never above it, its
 * bin real-path contained in the project (`projectPackageBin.ts`). No tracked
 * fixture carries a `node_modules` — committing an installed tree is what
 * `.gitignore`'s studio-workspace section exists to prevent — so their dev
 * servers never start, and every live-frame budget measured the fallback.
 *
 * ## What this one does instead
 *
 * It COPIES two packages out of this repository's own install into the
 * fixture's `node_modules`: `vite` (the bin Studio runs) and
 * `@vitejs/plugin-react` (the prototype shell's generated `vite.config.js`
 * imports it). Copies, not links: a link would resolve outside the project and
 * `resolveProjectPackageBin` refuses it, which is the point of that check.
 * Everything those two import — Rolldown, React, React DOM — resolves by
 * Node's normal upward search from the copy, which lands in this repository's
 * `node_modules`, because the e2e workspace (`.tmp/e2e-workspace`) lives
 * inside the checkout. Vite pre-bundles React into the fixture's own
 * `node_modules/.vite`, so nothing is served from outside the project root.
 *
 * ## The animated screen
 *
 * `pages/Animated.jsx` is the shape PERF-9 is about: a `requestAnimationFrame`
 * loop writing `style` on every frame (framer-motion, a spinner — attribute
 * records), a ticker rewriting a text node ten times a second (characterData),
 * and a carousel swapping a keyed child once a second (childList). Before
 * PERF-9's fix the first of those alone reset the frame's fit — a full-document
 * forced layout — sixty times a second.
 *
 * The other screens are plain, so a board of `LIVE_BOARD_FRAME_COUNT` frames
 * can hold more live frames than `LIVE_FRAME_POOL_SIZE` (8) and a pan can
 * evict one — the per-frame memory measurement.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createAuthoredFixtureProject, type FixtureProject } from './studioFixtureProject'

export const LIVE_ANIMATED_FIXTURE_NAME = '__live-animated-fixture'
export const ANIMATED_PAGE_ID = 'animated'
/** Ten frames: two more than the live pool holds. */
export const LIVE_BOARD_FRAME_COUNT = 10
const FRAMES_PER_ROW = 5
const FRAME_WIDTH = 480
const FRAME_HEIGHT = 600

/** The packages copied from this checkout's install — see the module doc. */
const COPIED_PACKAGES = ['vite', path.join('@vitejs', 'plugin-react')]

function plainScreenId(index: number): string {
  return `screen${String(index + 1).padStart(2, '0')}`
}

function plainScreenSource(index: number): string {
  const name = `Screen${String(index + 1).padStart(2, '0')}`
  const items = Array.from({ length: 24 }, (_, i) => `        <li className="item">Row ${i + 1} of screen ${index + 1}</li>`).join('\n')
  return (
    `export default function ${name}() {\n` +
    `  return (\n` +
    `    <main className="screen">\n` +
    `      <h1 className="title">${name}</h1>\n` +
    `      <ul className="list">\n${items}\n      </ul>\n` +
    `    </main>\n` +
    `  )\n` +
    `}\n`
  )
}

const ANIMATED_SOURCE = `import { useEffect, useRef, useState } from 'react'

const SLIDES = ['First slide', 'Second slide', 'Third slide']

export default function Animated() {
  const spinner = useRef(null)
  const [tick, setTick] = useState(0)
  const [slide, setSlide] = useState(0)

  // Attribute records, every frame: what a spinner or framer-motion does.
  useEffect(() => {
    let handle = 0
    const startedAt = performance.now()
    const step = (now) => {
      if (spinner.current) spinner.current.style.transform = \`rotate(\${((now - startedAt) / 4) % 360}deg)\`
      handle = requestAnimationFrame(step)
    }
    handle = requestAnimationFrame(step)
    return () => cancelAnimationFrame(handle)
  }, [])

  // A text node rewritten ten times a second: a clock, a counter.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [])

  // A keyed child swapped once a second: a carousel.
  useEffect(() => {
    const id = setInterval(() => setSlide((n) => (n + 1) % SLIDES.length), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <main className="animated">
      <h1 className="animated__title">Animated</h1>
      <div className="animated__spinner" ref={spinner}>Spinner</div>
      <p className="animated__clock">Tick {tick}</p>
      <ul className="animated__carousel">
        <li key={slide} className="animated__slide">{SLIDES[slide]}</li>
      </ul>
      <p className="animated__body">A page that animates from JavaScript, the way most real apps do.</p>
    </main>
  )
}
`

/** Write the fixture and give it a real Vite. Returns the project. */
export function writeLiveAnimatedFixture(): FixtureProject {
  const pageIds = [ANIMATED_PAGE_ID, ...Array.from({ length: LIVE_BOARD_FRAME_COUNT - 1 }, (_, i) => plainScreenId(i))]
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: 'live-animated-fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite' },
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
        devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^5.0.0' },
      },
      null,
      2,
    ),
    '.studio/meta.json': JSON.stringify(
      {
        // Sorts after every real project, so it never becomes the default one.
        displayName: 'Zz Live Animated Fixture',
        platform: 'web',
        pagesDir: 'pages',
        trust: 'run-project',
        frameDefaults: { width: FRAME_WIDTH, height: FRAME_HEIGHT },
      },
      null,
      2,
    ),
    '.studio/boards.json': JSON.stringify(
      {
        version: 1,
        boards: [
          {
            id: 'laf-board-1',
            name: 'Live',
            frames: pageIds.map((pageId, index) => ({
              id: `laf-frame-${String(index + 1).padStart(2, '0')}`,
              pageId,
              x: (index % FRAMES_PER_ROW) * (FRAME_WIDTH + 80),
              y: Math.floor(index / FRAMES_PER_ROW) * (FRAME_HEIGHT + 200),
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
    'pages/Animated.jsx': ANIMATED_SOURCE,
  }
  for (let i = 0; i < LIVE_BOARD_FRAME_COUNT - 1; i += 1) {
    files[`pages/Screen${String(i + 1).padStart(2, '0')}.jsx`] = plainScreenSource(i)
  }
  const fixture = createAuthoredFixtureProject(LIVE_ANIMATED_FIXTURE_NAME, files)
  // `createAuthoredFixtureProject` keeps an existing `node_modules` (a dev
  // server from an earlier run may still hold it), so copy only what is missing.
  for (const pkg of COPIED_PACKAGES) {
    const target = path.join(fixture.dir, 'node_modules', pkg)
    if (fs.existsSync(path.join(target, 'package.json'))) continue
    fs.cpSync(path.join(process.cwd(), 'node_modules', pkg), target, { recursive: true, dereference: true })
  }
  return fixture
}

/** The page ids on the board, in board order. */
export function liveBoardPageIds(): string[] {
  return [ANIMATED_PAGE_ID, ...Array.from({ length: LIVE_BOARD_FRAME_COUNT - 1 }, (_, i) => plainScreenId(i))]
}
