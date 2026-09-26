/**
 * evalReadFiles — the evaluator's record of which files a value was READ
 * through (WB-2).
 *
 * `server/handlers/studio/pageParseCache.ts` answers a route's parse from
 * memory while every file that parse depended on keeps its mtime. It used to
 * be told only about the route's own file and its inlined local components,
 * so `<h1>{COPY.title}</h1>` — `COPY` in `src/copy.ts` — cached a page whose
 * text had been read out of a file nobody was watching. A `literal` edit (the
 * write behind resolved text) rewrote `src/copy.ts`, and every later load
 * still served the old copy: the edit reverted itself on reload.
 *
 * So the evaluator now reports every file it reads a value out of into
 * `StaticEvalOptions.readFiles`, and the load merges that set into the
 * route's dependency set. The places a value can come from another file:
 *
 * - a module-scope `const` (`evaluateModuleConst`) — the file it is declared in;
 * - an import whose target is a `SourceFile` — the target, even when the
 *   binding is a function the caller will go on to call (Tier C);
 * - a `?raw` text import — the text file read off disk; an image import —
 *   the image the sentinel path names;
 * - a provider trace (Tier B) — every file the hook, the context and the
 *   provider's `value` were read from;
 * - a CSS-in-JS extraction — the file, and every file its interpolations read.
 *
 * ## Memos replay what they read
 *
 * Every memo on that list (`moduleConstCache`, `providerTraceCache`, the
 * css-in-js `fileCache`) is keyed by the file the ANSWER lives in, but the
 * answer may have been read THROUGH other files. A page that hits the memo
 * must still report all of them — otherwise the second page to read
 * `COPY.title` records `src/copy.ts` and nothing `COPY` itself imported. So
 * each memo entry stores the files its computation read (`collectReads`) and
 * a hit replays them (`recordReadFiles`). A computation's reads are collected
 * whether or not the caller asked for them, because the entry outlives the
 * call that built it.
 *
 * Paths are absolute and platform-native (`path.resolve`), the same form
 * `inlineLocalComponents`' `dependencyFiles` and `pageParseCache` use.
 */
import * as path from 'node:path'
import type { SourceFile } from 'ts-morph'

/** One absolute, platform-native path — the key `pageParseCache` and `reloadScope` compare on. */
function readFilePath(file: SourceFile | string): string {
  return path.resolve(typeof file === 'string' ? file : file.getFilePath())
}

/** Adds `file` to `sink`. A no-op without a sink — reporting is opt-in for every caller except a memo (see `collectReads`). */
export function recordReadFile(sink: Set<string> | undefined, file: SourceFile | string): void {
  sink?.add(readFilePath(file))
}

/** Replays a memo entry's recorded reads into `sink`. */
export function recordReadFiles(sink: Set<string> | undefined, files: Iterable<string>): void {
  if (!sink) return
  for (const file of files) sink.add(file)
}

/**
 * Runs `evaluate` with a FRESH read set on `holder` (the evaluator's `Budget`,
 * or a css-in-js options bag), then replays it into the caller's own set and
 * hands it back — the files a memo entry must replay on every later hit.
 * Collected even when the caller asked for nothing: the entry outlives the
 * call that built it.
 */
export function collectReads<T>(
  holder: { readFiles?: Set<string> | undefined },
  evaluate: () => T,
): { result: T; files: readonly string[] } {
  const outer = holder.readFiles
  const reads = new Set<string>()
  holder.readFiles = reads
  try {
    return { result: evaluate(), files: [...reads] }
  } finally {
    holder.readFiles = outer
    recordReadFiles(outer, reads)
  }
}
