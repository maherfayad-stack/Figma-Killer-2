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
 * .sass/.less/.json/.svg` file `listWorkspaceFiles` walks, plus `.studio/meta.json`
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
 * ## Every load stores the FULL result
 *
 * A narrowed load (`options.pageIds`, the canvas's targeted reload) runs the
 * same compute and converts every route — narrowing happens on the way out,
 * by filtering `pages`. So the result it computed IS the project-wide truth,
 * it is stored like any other, and the full load that follows a canvas
 * resync is a memo hit rather than a second parse.
 *
 * In-memory, process-scoped, one entry per `dir` — same posture as
 * `pageParseCache.ts` and the kept ts-morph `Project` in `workspaceProject.ts`.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { canvasLayerRelPath } from '@core/studio-board'
import { listCanvasLayerIds } from './canvasLayerFiles'
import type { StudioLoadResult } from './studioLoadContract'

/**
 * Extensions whose content can change what `loadStudioPages` returns. `svg`
 * (WB-2) because a `?raw` icon import's VALUE is the file's text — the parse
 * cache records the file as a dependency, and that is only worth anything if
 * this memo lets the load reach it.
 */
const FINGERPRINTED_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|svg)$/i

/**
 * `.studio/meta.json` fields that change WITHOUT changing a load result, and
 * must therefore be excluded from the fingerprint.
 *
 * `lastOpenedAt` is the whole reason this list exists. `GET /admin/api/studio/
 * load` stamps it through `recordProjectOpened` on its way in — and the board
 * calls that same route to re-sync after EVERY structural edit. Fingerprinting
 * the file by mtime therefore guaranteed a different fingerprint on every
 * single load, so the memo below could never hit once, and every duplicate,
 * insert, wrap and group paid a full cold `computeStudioPages` (~600 ms on a
 * two-page project, measured) for work the previous gesture had already done.
 * The memo was correct; it was being invalidated by its own reader.
 *
 * `trustAutoPromotedAt` is here for the same reason and not because it has
 * ever been observed to bite: it is a timestamp beside a boolean latch, and
 * `trustAutoPromoted` — the field that actually decides anything — is NOT
 * excluded, so the promotion itself still invalidates.
 *
 * The list is an EXCLUDE list, not an include list, deliberately: a new
 * parse-relevant field added to `StudioMeta` is covered automatically, and
 * only a field someone consciously names here can ever be ignored. Under-
 * invalidating serves stale source; over-invalidating only costs time.
 */
const NON_PARSE_META_FIELDS = new Set(['lastOpenedAt', 'trustAutoPromotedAt'])

/**
 * Inside `EXCLUDED_WORKSPACE_DIR_NAMES`, so `listWorkspaceFiles` never reports
 * it — but it decides pagesDir, locale, framework, trust and stories, so it is
 * fingerprinted by CONTENT (minus the fields above) rather than by mtime.
 */
const META_RELATIVE_PATH = '.studio/meta.json'

function fileStamp(absFile: string): string {
  try {
    const stat = statSync(absFile)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * `.studio/meta.json`'s contribution: its parsed content with the fields above
 * removed, re-serialised with sorted keys so a rewrite that only reorders them
 * is not mistaken for a change.
 *
 * Reading and parsing rather than stat-ing is affordable precisely because it
 * is ONE small file — and it is the only way to tell "the trust tier moved"
 * apart from "the board re-synced". Unreadable or malformed falls back to the
 * raw bytes, which is the conservative answer: a file this function cannot
 * understand must still invalidate when it changes.
 */
function metaStamp(dir: string): string {
  const absFile = join(dir, ...META_RELATIVE_PATH.split('/'))
  let raw: string
  try {
    raw = readFileSync(absFile, 'utf8')
  } catch {
    return 'missing'
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    const stable = Object.entries(parsed as Record<string, unknown>)
      .filter(([key]) => !NON_PARSE_META_FIELDS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify(stable)
  } catch {
    return raw
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
  parts.push(`${META_RELATIVE_PATH}:${metaStamp(dir)}`)
  // P5-G — the free canvas's layer modules live under `.studio/canvas/`, which
  // the walk above never enters, and a load returns them (`canvasLayers`). A
  // layer created, placed or edited outside Studio must invalidate like any
  // page file does, so each one is stamped explicitly, the way meta.json is.
  for (const id of listCanvasLayerIds(dir)) {
    const rel = canvasLayerRelPath(id)
    parts.push(`${rel}:${fileStamp(join(dir, ...rel.split('/')))}`)
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
