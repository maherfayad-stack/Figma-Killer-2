/**
 * studioDownload — "Download the code" (Phase 6D): zips a project's real
 * source files as-is. NOT codegen — the workspace's filesystem IS the source
 * of truth, so this only packages what's already there. Split out of
 * `studio.ts` to keep that file under the module-size ceiling; this is a
 * self-contained "walk a dir → zip it" concern with its own doc/tests.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { listWorkspaceFiles, WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_FILES } from '@core/page-parser'
import { ensureDesignSystemFiles } from './studio/designSystemFiles'
import { ensurePrototypeShell } from './studio/prototypeShell'
import { jsonResponse } from '../http'
import { binaryResponse } from '../binary'

/** One real source file collected from the workspace for the download zip. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, using `/` separators (zip-safe). */
  relPath: string
  contents: Buffer
}

interface CollectWorkspaceFilesOptions {
  /** Files larger than this are skipped outright — never partially included. */
  maxFileBytes?: number
  /** Total file count cap — collection stops (not truncates a file) once hit. */
  maxFiles?: number
}

/**
 * Recursively collects every real source file under `dir` for the "Download
 * code" export (Phase 6D). Pure-ish (dir + options in, file list out) so it's
 * unit-testable against a temp fixture directory without a Request/Response
 * round trip — mirrors `applyStudioEdit`'s testing shape.
 *
 * The recursive walk + exclusion rule (`.studio/`, `.git/`, `node_modules/`,
 * `dist/`, `.next/`, `.turbo/`, never following symlinks) is shared with the
 * Phase 7A workspace-discovery walk via `listWorkspaceFiles`
 * (`@core/page-parser`) — one exclusion list, not a duplicated one per
 * call site.
 *
 * Beyond that shared walk, this function adds: oversized files (> `maxFileBytes`)
 * are skipped whole, never truncated; collection stops (does not throw) once
 * `maxFiles` is reached, so the caller still gets a valid, if partial, zip
 * rather than an unbounded one.
 */
export function collectWorkspaceFiles(
  dir: string,
  options: CollectWorkspaceFilesOptions = {},
): WorkspaceFile[] {
  const maxFileBytes = options.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? WORKSPACE_MAX_FILES
  const results: WorkspaceFile[] = []

  for (const relPath of listWorkspaceFiles(dir)) {
    if (results.length >= maxFiles) break
    const filePath = join(dir, ...relPath.split('/'))
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      continue
    }
    if (size > maxFileBytes) continue // skip whole — never emit a partial file
    results.push({ relPath, contents: readFileSync(filePath) })
  }

  return results
}

/**
 * Minimal package.json synthesized when the workspace ships none of its own.
 *
 * **No design-system dependency**, deliberately: a DS-backed project carries
 * the design system as a `design-system/` FOLDER, which is ordinary source and
 * goes into the zip like every other source folder. The previous version named
 * `@alm-design/design-system` here, which made the download's own instructions
 * ("unzip, `bun install`, `bun run dev`") fail on a package no registry
 * serves. React and Vite are the whole dependency set now.
 *
 * Rarely reached in practice: `ensurePrototypeShell` merges a real
 * `package.json` into the workspace before the walk, so a project with none of
 * its own has one by the time it is collected. Kept as the honest fallback for
 * a workspace whose manifest is unreadable or over the per-file size cap.
 */
function synthesizedPackageJson(): Uint8Array {
  return strToU8(
    `${JSON.stringify(
      {
        name: 'studio-workspace',
        private: true,
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
        devDependencies: { '@vitejs/plugin-react': '^5.0.0', vite: '^7.0.0' },
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Builds the `GET /admin/api/studio/download` response for `dir`: a zip of
 * every real source file, with a synthesized `package.json` when the
 * workspace doesn't ship its own. `node_modules` is never bundled either way —
 * which is exactly why a DS-backed project's design system is a
 * `design-system/` folder of real source rather than an installed package: the
 * zip has to build on its own, with only what npm can still serve.
 */
export function buildStudioDownloadResponse(dir: string): Response {
  if (!existsSync(dir)) {
    return jsonResponse({ error: `Workspace directory not found: ${dir}` }, { status: 404 })
  }

  // Regenerate the preview shell's `.generated` half FIRST, so the zip carries
  // the boards as they are right now rather than as they were when the project
  // was last opened. `.studio/` is excluded from the download by design, so
  // `registry.generated.jsx` is the only copy of the board layout that reaches
  // the export — and a board created since the load memo was warmed would
  // otherwise be missing from it entirely. Never throws.
  ensurePrototypeShell(dir)
  // Same reasoning for the design system: `design-system/` is ordinary source
  // and goes into the zip like any other folder, so a project whose copy is
  // stale (or whose folder was never written because it has not been opened
  // since it became DS-backed) must be brought up to date BEFORE the walk.
  // A no-op for every project that is not design-system-backed, and for every
  // one whose folder already matches. Never throws.
  ensureDesignSystemFiles(dir)

  const files = collectWorkspaceFiles(dir)
  const zipInput: Record<string, Uint8Array> = {}
  let hasPackageJson = false
  for (const file of files) {
    zipInput[file.relPath] = file.contents
    if (file.relPath === 'package.json') hasPackageJson = true
  }
  if (!hasPackageJson) {
    zipInput['package.json'] = synthesizedPackageJson()
  }

  const zipped = zipSync(zipInput)
  return binaryResponse(zipped, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="studio-workspace.zip"',
    },
  })
}
