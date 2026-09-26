/**
 * The canvas, the shared UI primitives and the inspector are compiled by the
 * React Compiler — every function in them, and they stay that way.
 *
 * CLAUDE.md bans manual memoization because "the React Compiler memoizes every
 * component". It does not, silently: a function the compiler cannot lower is
 * emitted unchanged and reported only to a logger, so neither `bun run build`
 * nor `bun run lint` (the lint plugin runs its own Babel) ever fails on it.
 * P6-C found `CanvasRoot` skipped that way (its context values were rebuilt on
 * every render, re-rendering every mounted frame's chrome per click); the
 * inventory after it found 212 functions skipped across `src/`, 114 of them in
 * the directories below — `NodeRenderer`, `Button`, `Tooltip`,
 * `BreakpointSelectionOverlay`, `IframeFrameSurface`, `PropertiesPanel` among
 * them. Most were the toolchain (the compiler on Babel 8, see
 * `scripts/vite/reactCompilerPlugin.ts`); the rest were constructs the
 * compiler cannot lower, rewritten one by one.
 *
 * This compiles every source file under `GATED_DIRS` through
 * `reactCompilerBabelOptions` — the exact transform Vite ships — and fails on
 * any skipped function not in `ALLOWED`, naming the compiler's reason. The
 * usual ones, and the rewrite that compiles:
 *
 *   - `try { … } finally { … }` → move the `finally` body after a `try/catch`
 *     that does not rethrow, or use a promise's `.finally(…)`;
 *   - `a && b`, `a ? b : c`, `a?.b`, `a ?? b`, a loop — inside a `try` → move
 *     it to a module-level function and call that;
 *   - `x ??= y` → `x = x ?? y`;  `++captured` → `(captured += 1)`;
 *   - `import()` inside a component → a module-level loader function;
 *   - a ref written or read during render → state or `useEffectEvent`;
 *   - `{ ['--x' as string]: v }` → `{ '--x': v } as CSSProperties`.
 *
 * `bun run compiler:bailouts [dir…]` lists every skipped function in `src/`.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { transformSync } from 'babel-core-7'
import { reactCompilerBabelOptions, type ReactCompilerEvent } from '../../../scripts/vite/reactCompilerPlugin'
import { compileReport } from '../../../scripts/vite/reactCompilerReport'
import { readSource, REPO_ROOT, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

/** Every function in these directories must compile. */
const GATED_DIRS = [
  'src/admin/pages/site/canvas',
  'src/ui/components',
  'src/admin/pages/site/inspector',
  'src/admin/pages/site/panels/PropertiesPanel',
  'src/admin/pages/site/property-controls',
] as const

/**
 * `path#function` -> why it may stay uncompiled. Empty today: every function
 * in `GATED_DIRS` compiles. An entry needs a reason the compiler cannot be
 * given what it needs, not "it was like this".
 */
const ALLOWED: Readonly<Record<string, string>> = {}

/**
 * Hot functions OUTSIDE `GATED_DIRS` that must compile too: each runs on
 * every store change the canvas cares about.
 */
const HOT_ELSEWHERE: Readonly<Record<string, readonly string[]>> = {
  'src/admin/pages/site/hooks/useCanvas.ts': ['useCanvas'],
}

const GATE_TIMEOUT_MS = 120_000

function gatedSources(dir: string): string[] {
  return walkSourceTree(join(REPO_ROOT, dir), ['.ts', '.tsx'])
    .filter((path) => !/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts'))
    .filter((path) => !toRepoRelativePosix(path).includes('/__tests__/'))
}

describe('React Compiler bailouts', () => {
  it('the compiler runs on a Babel it can lower destructured defaults with', () => {
    // Under Babel 8 this exact shape was skipped (P6-C) — if the toolchain
    // drifts back, every gated directory would fail at once; this names why.
    const events: ReactCompilerEvent[] = []
    transformSync(
      'export function Probe({ label = "x" }: { label?: string }) { return <b>{label}</b> }',
      reactCompilerBabelOptions('Probe.tsx', (event) => events.push(event)),
    )
    expect(events.map((event) => event.kind)).toEqual(['CompileSuccess'])
  })

  it('Vite compiles with that transform, and with no other React Compiler plugin', () => {
    // Read as text: importing Vite inside `bun test` is not reliable.
    const config = readSource(join(REPO_ROOT, 'vite.config.ts'))
    const manifest = readSource(join(REPO_ROOT, 'package.json'))
    expect(config).toMatch(/^import \{ reactCompiler \} from '\.\/scripts\/vite\/reactCompilerPlugin'$/m)
    expect(config).toMatch(/^\s+reactCompiler\(\),$/m)
    for (const source of [config, manifest]) {
      expect(source).not.toContain('@rolldown/plugin-babel')
      expect(source).not.toContain('reactCompilerPreset')
    }
  })

  for (const dir of GATED_DIRS) {
    it(
      `${dir}: no function is skipped`,
      () => {
        const unexpected: string[] = []
        for (const path of gatedSources(dir)) {
          const file = toRepoRelativePosix(path)
          for (const bailout of compileReport(path).bailouts) {
            const key = `${file}#${bailout.fn}`
            if (!(key in ALLOWED)) unexpected.push(`${file}:${bailout.line} ${bailout.fn} — ${bailout.reason}`)
          }
        }
        expect([...new Set(unexpected)], 'the React Compiler skipped these (see this file’s docblock for the rewrites)').toEqual([])
      },
      GATE_TIMEOUT_MS,
    )
  }

  it('every ALLOWED entry still bails out (a fixed one is removed from the list)', () => {
    const stale = Object.keys(ALLOWED).filter((key) => {
      const [file, fn] = key.split('#') as [string, string]
      return !compileReport(join(REPO_ROOT, file)).bailouts.some((bailout) => bailout.fn === fn)
    })
    expect(stale).toEqual([])
  })

  for (const [file, names] of Object.entries(HOT_ELSEWHERE)) {
    it(`${file}: ${names.join(', ')} compile`, () => {
      const { compiled, bailouts } = compileReport(join(REPO_ROOT, file))
      for (const name of names) {
        const reasons = bailouts.filter((bailout) => bailout.fn === name).map((bailout) => bailout.reason)
        expect(compiled.includes(name), `${name} was not compiled: ${reasons.join(' | ') || '(not found)'}`).toBe(true)
      }
    })
  }
})
