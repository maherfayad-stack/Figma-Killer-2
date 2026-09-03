/**
 * Shared workspace directory-walk primitive — used both by the server-side
 * "download the code" zip export (`server/handlers/studio.ts`), the GitHub
 * import writer (`server/handlers/studioGithubImport.ts`), and by
 * `componentSources.ts`'s multi-file ts-morph `Project` (which must not add
 * build output / dependency source as if it were app code). One exclusion
 * list, reused everywhere a studio workspace is walked recursively, per
 * CLAUDE.md's "no duplicated old/new paths" rule.
 */
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** Directory names skipped entirely — never descended into, anywhere in the tree. */
export const EXCLUDED_WORKSPACE_DIR_NAMES: ReadonlySet<string> = new Set([
  '.studio', // editor-owned spatial metadata (boards.json) — not app code
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.turbo',
])

/**
 * The directory Studio scaffolds its runnable preview app into
 * (`ensurePrototypeShell`), and the one exclusion that is NOT in the set
 * above.
 *
 * The distinction is the whole point. `prototype/` MUST be walked by
 * `listWorkspaceFiles`, because "Download the code" has to ship the shell —
 * that is what makes the export runnable. But nothing in the PARSE pipeline
 * may treat it as the user's app: it is Studio's own scaffold, sitting inside
 * the user's repository.
 *
 * Getting that wrong is not a subtle failure. The shell writes an
 * `index.html` whose module script points at `prototype/main.jsx`, so
 * `findEntryFile` adopted it as the project's entry point and walked the
 * shell's own `shell.css` and `CanvasPanel.css` in as the user's design
 * system — Studio reading its own scaffold back as the thing being designed.
 * Every page in a scaffolded workspace picked up style rules nobody wrote.
 *
 * One constant, consulted by every part of the pipeline that asks "is this
 * the user's source?" — `findEntryFile` and the entry-stylesheet walk here,
 * `NON_PAGES_DIR_SEGMENTS` in `projectProbe`, and the local-component catalog
 * in `componentSpecExtract`.
 */
export const PROTOTYPE_SHELL_DIR = 'prototype'

/** True when a workspace-relative POSIX path is inside Studio's own preview shell rather than the user's app. */
export function isPrototypeShellPath(relPath: string): boolean {
  return relPath === PROTOTYPE_SHELL_DIR || relPath.startsWith(`${PROTOTYPE_SHELL_DIR}/`)
}

/**
 * Shared workspace size caps — one number reused by every operation that
 * copies a whole studio workspace around (the download zip in
 * `collectWorkspaceFiles`, and the GitHub import writer's per-file /
 * file-count guards). Files larger than `WORKSPACE_MAX_FILE_BYTES` are
 * skipped outright, never partially included/written; collection/import
 * stops (does not throw) once `WORKSPACE_MAX_FILES` is reached.
 */
export const WORKSPACE_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB — generous for source/text/small assets
export const WORKSPACE_MAX_FILES = 5000

/**
 * Recursively lists every real file under `dir` as a POSIX-separated path
 * relative to `dir`, in deterministic sorted order. Skips directories named
 * in `EXCLUDED_WORKSPACE_DIR_NAMES` (anywhere in the tree) and never follows
 * symlinks — a symlink can't walk the result outside `dir`. Pure(ish): only
 * reads directory entries, never stats or reads file contents, so it's cheap
 * to call for "just the file list" use sites (page discovery) as well as
 * heavier ones (the download zip, which stats/reads each entry itself).
 */
export function listWorkspaceFiles(dir: string): string[] {
  const results: string[] = []

  function walk(currentDir: string, relDir: string): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // Never follow symlinks — keeps any consumer confined to `dir`.
      if (entry.isSymbolicLink()) continue
      const entryRelPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (EXCLUDED_WORKSPACE_DIR_NAMES.has(entry.name)) continue
        walk(join(currentDir, entry.name), entryRelPath)
        continue
      }
      if (entry.isFile()) results.push(entryRelPath)
    }
  }

  walk(dir, '')
  return results.sort()
}
