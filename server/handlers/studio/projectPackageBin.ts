/**
 * projectPackageBin — the bin script a project's OWN install provides for a
 * package, found the way a package manager would put it on `PATH`, and never
 * outside the project.
 *
 * Studio runs a project's tool (its linter) by running that package's bin file
 * directly with a JavaScript runtime — never through `<pm> run <script>`,
 * which also runs the repository's `pre<script>`/`post<script>` hooks, and
 * never through `npx`, which can download and run a package the project did
 * not install. The security-hardening bundle made the same move for the dev
 * server (`viteLaunch.ts`, review of #233 F3.4); this is the package-agnostic
 * half of that rule, so a second Tier-2 tool does not grow a second copy of
 * the lookup.
 *
 * ## Which install
 *
 * `node_modules/<pkg>` from the app root up to the project directory (a
 * monorepo hoists to the root), never above the project. The bin file must
 * resolve, symlinks and all, inside the project: a repository can ship a
 * `node_modules` entry that is a link escaping it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { isRealpathContained } from './workspacePackageResolve'

/** The directories from `appRoot` up to and including `projectDir` (`appRoot` is inside it, `resolveAppRoot`). */
export function appRootToProjectDir(appRoot: string, projectDir: string): string[] {
  const root = resolve(projectDir)
  const out: string[] = []
  let current = resolve(appRoot)
  for (;;) {
    out.push(current)
    if (current === root) return out
    const rel = relative(root, current)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return out
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

const PackageBinSchema = Type.Object({
  bin: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.String())])),
})

/**
 * The absolute path of `binName` from the `pkg` the project installed, real-path
 * contained in `projectDir`, or `null` when the package is not installed there,
 * declares no such bin, or its bin escapes the project.
 */
export function resolveProjectPackageBin(appRoot: string, projectDir: string, pkg: string, binName: string): string | null {
  for (const dir of appRootToProjectDir(appRoot, projectDir)) {
    const pkgDir = join(dir, 'node_modules', pkg)
    let raw: string
    try {
      raw = readFileSync(join(pkgDir, 'package.json'), 'utf8')
    } catch {
      continue
    }
    const parsed = safeParseJson(raw, PackageBinSchema)
    if (!parsed.ok) return null
    const { bin } = parsed.value
    const rel = typeof bin === 'string' ? bin : bin?.[binName]
    if (typeof rel !== 'string' || rel.length === 0) return null
    const script = resolve(pkgDir, rel)
    return isRealpathContained(script, projectDir) ? script : null
  }
  return null
}

/** The runtime that runs a package bin: Node when it is on `PATH` (a bin is a `#!/usr/bin/env node` script), else this Bun. */
export function packageBinRuntime(): string {
  return Bun.which('node') ?? process.execPath
}
