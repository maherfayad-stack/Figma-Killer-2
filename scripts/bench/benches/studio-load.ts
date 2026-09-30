/**
 * Studio `/load` on a 1,000-file repository — audit `01-perf.md` §3 item 12
 * (PERF-8), ROADMAP P6-C.
 *
 * The board re-reads `GET /admin/api/studio/load` after every structural
 * gesture, and the agent's tools read the same memoized load several times a
 * turn. On a real repository the question is not the 40 pages (the canvas
 * budgets cover those) but everything AROUND them: 600 utility modules, 200
 * components, JSON, stylesheets. Before P6-B the warm path walked and stat'ed
 * every one of those files synchronously on each load; now it asks the
 * project's watcher. This bench is what keeps it that way.
 *
 * It calls `loadStudioPagesShared` — the route's own entry — in process and
 * serialises the result, which is all the route adds. No HTTP: a socket would
 * add noise and measure nothing about the load.
 *
 * Two numbers are gates (`STUDIO_LOAD_BUDGETS_MS`, a breach fails the bench):
 *
 *   - **warm load, median** — the repeat load with nothing changed.
 *   - **warm load, longest event-loop block** — the longest the server's
 *     single thread went without running anything else during those repeat
 *     loads. A warm load is mostly synchronous `stat`s, so this is the number
 *     a request queued behind it (a click's writeback) actually waits.
 *
 * The rest are recorded, not gated: the cold load (a fresh parse of every
 * route), the longest block in the seconds after it (the deferred program
 * prewarm and parse-store writes, P6-B's landmine 1), and a load after one
 * page edit.
 *
 * The corpus is generated into `.tmp/` on every run (deterministic, never
 * committed): 40 pages, 200 components (3 per page), 600 utility modules,
 * 100 JSON files and 60 stylesheets — P6-B's `thousand` corpus, so its A/B
 * numbers and these are the same measurement.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { BenchModule, BenchResult, BenchRow } from '../lib/types'
import { fmtMs, summarize } from '../lib/stats'
import { log } from '../lib/log'

/**
 * Calibrated on this Windows box under the usual multi-agent load, three runs:
 * warm median 31.5 / 46.6 / 31.3 ms, longest block (median) 31.1 / 31.2 /
 * 31.1 ms (worst single load 58-61 ms). Set at ~1.7x the worst median: loose
 * enough for machine noise, tight enough that the walk-and-stat warm path P6-B
 * removed (117.6 ms route median before it) fails.
 */
export const STUDIO_LOAD_BUDGETS_MS = {
  warmMedian: 80,
  warmLongestBlock: 80,
} as const

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']
const PAGE_COUNT = 40

function screenName(index: number): string {
  return `Screen${String(index + 1).padStart(2, '0')}`
}

function write(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

/** Writes the corpus and returns how many source files it holds. */
function writeThousandFileRepo(root: string): number {
  rmSync(root, { recursive: true, force: true })
  write(
    root,
    '.studio/meta.json',
    JSON.stringify({ displayName: 'Thousand', platform: 'web', pagesDir: 'pages', trust: 'static', frameDefaults: { width: 1024, height: 800 } }, null, 2),
  )
  write(
    root,
    '.studio/boards.json',
    JSON.stringify(
      {
        version: 1,
        boards: [
          {
            id: 'tfr-board',
            name: 'Board',
            frames: Array.from({ length: PAGE_COUNT }, (_, i) => ({
              id: `tfr-f${i}`,
              pageId: screenName(i).toLowerCase(),
              x: (i % 5) * 1104,
              y: Math.floor(i / 5) * 3000,
              width: 1024,
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
  )
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', strict: true } }, null, 2))
  let files = 1
  for (let u = 0; u < 600; u += 1, files += 1) {
    write(root, `src/utils/util${u}.ts`, `export const LABEL_${u} = 'Label ${u}'\nexport function fmt${u}(n: number) { return n * ${u} }\n`)
  }
  for (let j = 0; j < 100; j += 1, files += 1) write(root, `src/data/data${j}.json`, JSON.stringify({ id: j, items: WORDS }))
  for (let c = 0; c < 60; c += 1, files += 1) write(root, `src/styles/s${c}.css`, `.c${c} { color: red; padding: ${c}px; }\n`)
  for (let k = 0; k < 200; k += 1, files += 1) {
    const items = Array.from({ length: 12 }, (_, i) => `        <li>item ${k}.${i}</li>`).join('\n')
    write(
      root,
      `src/components/Comp${k}.tsx`,
      `import { LABEL_${k} } from '../utils/util${k}'\n\nexport function Comp${k}() {\n  return (\n    <div className="comp">\n      <h3>{LABEL_${k}}</h3>\n      <ul>\n${items}\n      </ul>\n    </div>\n  )\n}\n`,
    )
  }
  for (let p = 0; p < PAGE_COUNT; p += 1, files += 1) {
    const comps = [(p * 5) % 200, (p * 5 + 1) % 200, (p * 5 + 2) % 200]
    const paragraphs = Array.from({ length: 30 }, (_, i) => `      <p className="c${p}">Paragraph ${i}</p>`).join('\n')
    write(
      root,
      `pages/${screenName(p)}.tsx`,
      `${comps.map((c) => `import { Comp${c} } from '../src/components/Comp${c}'`).join('\n')}\nimport '../src/styles/s${p}.css'\n\n` +
        `export default function ${screenName(p)}() {\n  return (\n    <main>\n      <h1>Screen ${p}</h1>\n${comps.map((c) => `      <Comp${c} />`).join('\n')}\n${paragraphs}\n    </main>\n  )\n}\n`,
    )
  }
  return files
}

/**
 * The longest stretch the event loop went without running a timer while
 * `work` ran (or for `holdMs` after it, when given). A 1 ms interval is the
 * probe: every gap past it is time something held the thread.
 */
async function longestBlockDuring<T>(work: () => Promise<T>, holdMs = 0): Promise<{ value: T; longestBlockMs: number }> {
  let last = performance.now()
  let longest = 0
  const probe = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  try {
    const value = await work()
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs))
    // One more turn so a block that ended the work is observed.
    await new Promise((resolve) => setTimeout(resolve, 2))
    return { value, longestBlockMs: longest }
  } finally {
    clearInterval(probe)
  }
}

export const studioLoadBench: BenchModule = {
  name: 'studio-load',
  title: 'Studio /load on a 1,000-file repository',
  description: 'Warm and cold `/load` (loadStudioPagesShared + serialise) on a generated 1,000-file repo, with the longest event-loop block. Gated.',
  async run(ctx): Promise<BenchResult> {
    const { loadStudioPagesShared } = await import('../../../server/handlers/studioPageLoad')
    const { clearLoadedProjects } = await import('../../../server/handlers/studio/loadedProjects')
    const root = join(ctx.outputDir, 'studio-load', 'thousand')
    log.step('Generating the 1,000-file corpus')
    const fileCount = writeThousandFileRepo(root)

    const load = async () => {
      const result = await loadStudioPagesShared(root)
      return JSON.stringify(result).length
    }

    log.step('Cold load (empty parse store), then the 3 s after it')
    const coldStart = performance.now()
    const cold = await longestBlockDuring(load)
    const coldMs = performance.now() - coldStart
    const afterCold = await longestBlockDuring(async () => undefined, 3000)
    log.detail(`    cold ${fmtMs(coldMs)}, ${(cold.value / 1e6).toFixed(2)} MB; longest block in the 3 s after: ${fmtMs(afterCold.longestBlockMs)}`)

    const iterations = ctx.quick ? 7 : 21
    log.step(`Warm load x${iterations}`)
    const warmSamples: number[] = []
    const warmBlocks: number[] = []
    for (let i = 0; i < iterations; i += 1) {
      const startedAt = performance.now()
      const run = await longestBlockDuring(load)
      warmSamples.push(performance.now() - startedAt)
      warmBlocks.push(run.longestBlockMs)
    }
    const warm = summarize(warmSamples)
    const blocks = summarize(warmBlocks)
    log.detail(`    warm median=${fmtMs(warm.p50)} p95=${fmtMs(warm.p95)}; longest block median=${fmtMs(blocks.p50)} worst=${fmtMs(blocks.max)}`)

    log.step('One page edited, then a load')
    const edited = join(root, 'pages', `${screenName(6)}.tsx`)
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n/* ${Date.now()} */\n`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const editStart = performance.now()
    await load()
    const editMs = performance.now() - editStart
    log.detail(`    after a page edit ${fmtMs(editMs)}`)

    clearLoadedProjects()

    const budgetFailures: string[] = []
    if (warm.p50 > STUDIO_LOAD_BUDGETS_MS.warmMedian) {
      budgetFailures.push(`warm /load median ${fmtMs(warm.p50)} > ${fmtMs(STUDIO_LOAD_BUDGETS_MS.warmMedian)}`)
    }
    if (blocks.p50 > STUDIO_LOAD_BUDGETS_MS.warmLongestBlock) {
      budgetFailures.push(`warm /load longest event-loop block (median) ${fmtMs(blocks.p50)} > ${fmtMs(STUDIO_LOAD_BUDGETS_MS.warmLongestBlock)}`)
    }

    const rows: BenchRow[] = [
      {
        label: 'warm load (nothing changed)',
        inputs: { files: fileCount, pages: PAGE_COUNT, samples: iterations },
        metrics: {
          median: fmtMs(warm.p50),
          p95: fmtMs(warm.p95),
          min: fmtMs(warm.min),
          max: fmtMs(warm.max),
          budget_median: fmtMs(STUDIO_LOAD_BUDGETS_MS.warmMedian),
          verdict: warm.p50 <= STUDIO_LOAD_BUDGETS_MS.warmMedian ? 'within' : 'OVER',
        },
      },
      {
        label: 'warm load: longest event-loop block',
        inputs: { samples: iterations },
        metrics: {
          median: fmtMs(blocks.p50),
          worst: fmtMs(blocks.max),
          budget_median: fmtMs(STUDIO_LOAD_BUDGETS_MS.warmLongestBlock),
          verdict: blocks.p50 <= STUDIO_LOAD_BUDGETS_MS.warmLongestBlock ? 'within' : 'OVER',
        },
      },
      { label: 'cold load (empty parse store)', metrics: { ms: fmtMs(coldMs), longest_block: fmtMs(cold.longestBlockMs), payload_mb: (cold.value / 1e6).toFixed(2) } },
      { label: 'longest block in the 3 s after the cold load', metrics: { ms: fmtMs(afterCold.longestBlockMs) }, notes: 'The deferred program prewarm and parse-store writes (P6-B). Recorded, not gated.' },
      { label: 'load after one page edit', metrics: { ms: fmtMs(editMs) } },
    ]

    return {
      name: 'studio-load',
      title: 'Studio /load on a 1,000-file repository',
      headline: {
        warm_median: fmtMs(warm.p50),
        warm_block: fmtMs(blocks.p50),
        cold: fmtMs(coldMs),
      },
      sections: [
        {
          title: '`/load` warm path (audit 01-perf §3 item 12)',
          intro:
            '`loadStudioPagesShared` + `JSON.stringify` — what `GET /admin/api/studio/load` does — on a generated repo of 1,000 source files. The two warm rows are gates (STUDIO_LOAD_BUDGETS_MS); a row reading OVER fails the bench.',
          rows,
        },
      ],
      ...(budgetFailures.length > 0 ? { budgetFailures } : {}),
    }
  },
}
