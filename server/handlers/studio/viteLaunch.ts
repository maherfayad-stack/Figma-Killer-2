/**
 * viteLaunch — the exact process a project's dev server is: the project's own
 * Vite, run directly, never through the package manager.
 *
 * ## Why not `npm run dev` (security review of #233, F3.4)
 *
 * `liveCapability.ts` only lets Studio run a project whose `dev` (else
 * `start`) script is a bare `vite` invocation, because Vite is the only thing
 * Studio can frame and a script is a shell command. But `npm run dev` does not
 * run only `dev`: it runs `predev` first and `postdev` after, and so does
 * Yarn 1, and so do pnpm and Bun depending on version and config. Every
 * project is Tier 2 by default and the board prewarms the dev server on open,
 * so a repository shipping `"predev": "curl … | sh"` ran it on first open —
 * the exact thing the `vite`-only rule (`sec-21`) exists to stop, through the
 * one door that rule does not look at. `--ignore-scripts` closes it for npm
 * only, and differently per package manager.
 *
 * So Studio runs what the script names and nothing else: the `vite` package's
 * own bin file, with the script's arguments, in the app root. No package
 * manager, no lifecycle scripts, no shell. `VITE_INVOCATION` already limits
 * those arguments to plain flag tokens.
 *
 * ## Which Vite
 *
 * The project's own install: `node_modules/vite` found from the app root up to
 * the project directory (a monorepo hoists it to the root), exactly as the
 * package manager would have put it on `PATH`, and never above the project.
 * Its bin file must resolve, symlinks and all, inside the project. A project
 * with no Vite installed does not boot — which is what `npm run dev` did too,
 * and the Dependencies panel is the fix. `npx vite` could have downloaded one;
 * Studio does not fetch and run a package the project did not install.
 *
 * ## Which runtime
 *
 * Node when it is on `PATH` — Vite's bin is a `#!/usr/bin/env node` script, so
 * that is what the package manager ran — else this Bun, which is also what
 * `bun run` falls back to on a host without Node (the Docker image).
 */
import { readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRealpathContained } from './workspacePackageResolve'

/** `npx vite …`, `bunx vite …`, `pnpm exec vite …`, `yarn vite …` → the tokens after `vite`. `null` for anything else. */
export function viteArgsFromScript(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)
  let index = 0
  if (tokens[index] === 'npx' || tokens[index] === 'bunx' || tokens[index] === 'pnpm' || tokens[index] === 'yarn') {
    index += 1
    if (tokens[index] === 'exec') index += 1
  }
  if (tokens[index] !== 'vite') return null
  return tokens.slice(index + 1)
}

/** The directories from `appRoot` up to and including `projectDir`. `appRoot` is already contained in it (`resolveAppRoot`). */
function appRootToProjectDir(appRoot: string, projectDir: string): string[] {
  const root = resolve(projectDir)
  const out: string[] = []
  let current = resolve(appRoot)
  for (;;) {
    out.push(current)
    if (current === root) return out
    const rel = relative(root, current)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return out
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/** The `vite` bin script the project installed, real-path contained in `projectDir`, or `null`. */
export function resolveProjectViteBin(appRoot: string, projectDir: string): string | null {
  for (const dir of appRootToProjectDir(appRoot, projectDir)) {
    const pkgDir = join(dir, 'node_modules', 'vite')
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const bin: unknown = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>).bin : undefined
    const rel = typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? (bin as Record<string, unknown>).vite : undefined
    if (typeof rel !== 'string' || rel.length === 0) return null
    const script = resolve(pkgDir, rel)
    return isRealpathContained(script, projectDir) ? script : null
  }
  return null
}

export type ViteLaunch =
  | { readonly ok: true; readonly argv: string[]; readonly binDirs: string[] }
  | { readonly ok: false; readonly error: string }

/**
 * The argv that runs the project's dev server, and the `node_modules/.bin`
 * directories the package manager would have put on `PATH` (a Vite plugin
 * that spawns a tool it depends on still finds it). See the module doc.
 */
export function viteLaunch(
  appRoot: string,
  projectDir: string,
  scriptCommand: string,
  runtime: string = Bun.which('node') ?? process.execPath,
): ViteLaunch {
  const args = viteArgsFromScript(scriptCommand)
  if (args === null) return { ok: false, error: 'The dev script is not a vite invocation, so Studio does not run it.' }
  const bin = resolveProjectViteBin(appRoot, projectDir)
  if (bin === null) {
    return { ok: false, error: 'Vite is not installed in this project. Install its dependencies (Dependencies panel), then open Live again.' }
  }
  const binDirs = appRootToProjectDir(appRoot, projectDir).map((dir) => join(dir, 'node_modules', '.bin'))
  return { ok: true, argv: [runtime, bin, ...args], binDirs }
}

/** `PATH` with `binDirs` in front, the way `npm run` sets it. */
export function pathWithBinDirs(path: string | undefined, binDirs: readonly string[]): string {
  return [...binDirs, ...(path ? [path] : [])].join(delimiter)
}
