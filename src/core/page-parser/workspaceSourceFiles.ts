/**
 * workspaceSourceFiles — which files of a workspace are the user's APP source:
 * the root set of the workspace-wide ts-morph `Project`.
 *
 * ONE selection rule, consulted both when the `Project` is first built
 * (`createWorkspaceProject`) and every time
 * `server/handlers/studio/workspaceProject.ts` brings a kept `Project` back in
 * step with the disk, so the two can never disagree about which files exist.
 *
 * It lives apart from `./workspaceFiles` because it needs both halves of the
 * answer: that module's walk and shell rule, and `./workspaceWriteScope`'s
 * host-config rule (which itself imports `./workspaceFiles`).
 */
import { isHostConfigFileName } from './workspaceWriteScope'
import { isPrototypeShellPath, listWorkspaceFiles } from './workspaceFiles'

/** The file kinds `createWorkspaceProject` hands to ts-morph — what the parser can read as a module. */
const WORKSPACE_SOURCE_FILE_RE = /\.(tsx?|jsx?)$/i

/**
 * Every file the workspace-wide ts-morph `Project` should contain, as POSIX
 * paths relative to `dir`, in deterministic order: `listWorkspaceFiles`
 * narrowed to `.ts/.tsx/.js/.jsx`, minus two kinds of file that are never the
 * app on the canvas.
 *
 *   - **Studio's own preview shell** (`isPrototypeShellPath`). Its generated
 *     runtime bundle is megabytes of minified JS, and parsing it cost more
 *     than every real page put together.
 *   - **Build-tool configuration** (`isHostConfigFileName`: `vite.config.js`,
 *     `tailwind.config.ts`, `.eslintrc.cjs`, …), the user's own included. A
 *     config runs in Node when a tool loads it; no page renders it and no page
 *     imports it. As a root it cost the whole toolchain's types: the shell's
 *     scaffolded `vite.config.js` imports `vite` and
 *     `prototype/studioRuntime.generated.js`, and TypeScript followed both —
 *     `vite`, `rolldown`, `postcss`, `@types/node`, `undici-types` and the
 *     2 MB runtime bundle. On the canonical fixture the program went from 86
 *     files to 288, and every program build (the load's, the prewarm's, each
 *     edit's) paid for it. `shellStaysOutOfTheParse.test.ts` pins the count.
 *
 * Leaving a file out of the roots does not hide it from a user file that
 * really imports it: TypeScript still follows that import. Only the files
 * nothing in the app reaches stop costing anything.
 */
export function listWorkspaceSourceFiles(dir: string): string[] {
  return listWorkspaceFiles(dir).filter(isWorkspaceSourcePath)
}

function isWorkspaceSourcePath(relPath: string): boolean {
  if (!WORKSPACE_SOURCE_FILE_RE.test(relPath) || isPrototypeShellPath(relPath)) return false
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  return !isHostConfigFileName(name)
}
