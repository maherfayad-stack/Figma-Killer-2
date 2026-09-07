/**
 * studioLoadMemo — W9-5 lever 1: **one real `loadStudioPages` per turn.**
 *
 * `pageParseCache.ts` (read it first) already makes the expensive half — the
 * per-route ts-morph parse and §7 evaluator pass — reusable across calls. What
 * it does NOT make reusable is everything `loadStudioPages` does AROUND those
 * parses: `createWorkspaceProject`, `compileProjectStyles`, the page/story
 * directory walks, `loadStudioStyles`' site-wide class-id registry, and the
 * per-page `parsedPageToSitePage` convert. On a 36-page project that residue
 * measured ~26 ms, and an agent turn pays it once in the live digest, again in
 * `studio_compare`, again in `studio_screenshot`/`studio_quality_check`, and
 * again in whatever fidelity tool runs next — all against a project that did
 * not change between them.
 *
 * This memo caches the WHOLE `StudioLoadResult` for a `dir`, so a repeat load
 * costs a fingerprint check plus a clone (~2.5 ms measured) instead of ~26 ms.
 *
 * ## Validity: a workspace fingerprint, not a dependency set
 *
 * `pageParseCache` records a per-route dependency set because it caches ONE
 * route and must invalidate precisely. This memo caches the whole project, so
 * "did anything at all change" is the only question, and the cheapest honest
 * answer is a fingerprint over every source-relevant file in the workspace:
 * `relPath:size:mtimeMs` for every `.ts/.tsx/.js/.jsx/.mjs/.cjs/.css/.scss/
 * .sass/.less/.json` file `listWorkspaceFiles` walks, plus `.studio/meta.json`
 * explicitly (`.studio` is in `EXCLUDED_WORKSPACE_DIR_NAMES`, and meta.json
 * decides `pagesDir`, the preview locale, the framework profile, the trust
 * tier and whether stories are on).
 *
 * That is deliberately BROADER than `pageParseCache`'s per-route dependency
 * set: it catches a page file added or deleted, a stylesheet edited, a
 * `tailwind.config.ts` change, a `package.json` dependency change, and the
 * transitive local-component edits `pageParseCache`'s documented one-level
 * limitation misses. A memo hit therefore never serves anything staler than
 * a fresh call would have computed. Measured cost on a 100-file project:
 * ~0.7 ms.
 *
 * ## Why the result is cloned on the way out
 *
 * Callers receive `Page` objects they are free to mutate (`loadStudioPages`
 * itself mutates them via `rewriteStudioAssetSentinels`). Handing two callers
 * the same object graph would make one tool's edit visible to the next, which
 * is a correctness bug, not a perf trade. `structuredClone` of a 36-page
 * result measured ~1.8 ms — an order of magnitude under the ~26 ms it saves —
 * so the memo always clones both in and out.
 *
 * ## Only FULL loads are stored
 *
 * A narrowed load (`options.pageIds`, the canvas's targeted reload) skips the
 * per-page convert for every other route, so its result is not a project-wide
 * truth and must never be stored. It can still be SERVED from a stored full
 * result by filtering `pages` — which is exactly what a narrowed load returns.
 *
 * In-memory, process-scoped, one entry per `dir` — same posture as
 * `pageParseCache.ts`.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import type { StudioLoadResult } from './studioLoadContract'

/** Extensions whose content can change what `loadStudioPages` returns. */
const FINGERPRINTED_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json)$/i

/** Inside `EXCLUDED_WORKSPACE_DIR_NAMES`, so `listWorkspaceFiles` never reports it — but it decides pagesDir, locale, framework, trust and stories. */
const EXTRA_FINGERPRINTED_FILES = ['.studio/meta.json'] as const

function fileStamp(absFile: string): string {
  try {
    const stat = statSync(absFile)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * A cheap, non-cryptographic signature of every file in `dir` whose content
 * could change a load result. Changes only need to be DETECTED, never
 * resisted — same posture as `pageParseCache.ts`'s `hashWorkspaceConfig`.
 */
export function workspaceLoadFingerprint(dir: string): string {
  const parts: string[] = []
  for (const relPath of listWorkspaceFiles(dir)) {
    if (!FINGERPRINTED_EXTENSIONS.test(relPath)) continue
    parts.push(`${relPath}:${fileStamp(join(dir, ...relPath.split('/')))}`)
  }
  for (const relPath of EXTRA_FINGERPRINTED_FILES) {
    parts.push(`${relPath}:${fileStamp(join(dir, ...relPath.split('/')))}`)
  }
  const payload = parts.join('\n')
  let hash = 0
  for (let i = 0; i < payload.length; i++) hash = (hash * 31 + payload.charCodeAt(i)) | 0
  return `${parts.length}:${hash.toString(36)}`
}

const memo = new Map<string, { fingerprint: string; result: StudioLoadResult }>()

/**
 * The memoized FULL load result for `dir`, or `null` when the memo is cold or
 * anything in the workspace moved. Always a fresh clone — see this module's
 * doc for why aliasing would be a correctness bug.
 */
export function getMemoizedStudioLoad(dir: string, fingerprint: string): StudioLoadResult | null {
  const entry = memo.get(dir)
  if (!entry || entry.fingerprint !== fingerprint) return null
  return structuredClone(entry.result)
}

/** Stores a FULL load result (never a narrowed one — see this module's doc) against the fingerprint the workspace had when it was computed. */
export function setMemoizedStudioLoad(dir: string, fingerprint: string, result: StudioLoadResult): void {
  memo.set(dir, { fingerprint, result: structuredClone(result) })
}

/** Test-only: drop every memoized load so a test does not leak state into the next one. */
export function clearStudioLoadMemo(): void {
  memo.clear()
}
