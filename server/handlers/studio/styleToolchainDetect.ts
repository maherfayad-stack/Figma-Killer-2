/**
 * styleToolchainDetect — WS-1.2's "what styling mechanism(s) does this
 * project use" rule (Tailwind v3/v4, Sass, CSS Modules, CSS-in-JS), extracted
 * out of `projectProbe.ts` purely to keep that module under the architecture
 * size ceiling (`src/__tests__/architecture/module-size-budgets.test.ts`) —
 * mirrors the sibling detectors already split out the same way
 * (`componentPackageDetect.ts`, `colorSchemeDetect.ts`, `designSystemDetect.ts`):
 * one detection question per file. Nothing here executes anything: every
 * answer comes from a config-file existence check, a `package.json`
 * dependency, or a text scan for `@import "tailwindcss"` / `.module.css`
 * naming.
 *
 * `detectStyleToolchain` is the one entry point `projectProbe.ts` calls —
 * it returns the WHOLE `ProjectProfile['styleToolchain']` shape (including
 * `postcssConfigPath`, previously a bare `findConfigFile` call inline in
 * `probeProject`) so the caller has one function to call instead of five.
 * Every path this returns is relative to the `root` it was called with (the
 * project's resolved APP ROOT, not necessarily the project directory) —
 * `probeProject` re-prefixes them with `appRoot` before they leave the
 * profile, exactly as it always has; this module knows nothing about that
 * prefixing.
 */
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { Type } from '@core/utils/typeboxHelpers'
import { readJsonFileSafe, readTextCapped } from './cappedFileRead'
import { findConfigFile, hasDependency, type PackageJsonShape } from './packageJsonRead'
import type { ProbeWarning, ProjectProfile } from './projectProfileSchema'

const VersionOnlySchema = Type.Object({ version: Type.Optional(Type.String()) })

const POSTCSS_CONFIG_NAMES = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts'] as const
const TAILWIND_CONFIG_NAMES = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'] as const

function resolveInstalledVersion(root: string, pkgName: string): string | undefined {
  return readJsonFileSafe(join(root, 'node_modules', ...pkgName.split('/'), 'package.json'), VersionOnlySchema, 200_000)?.version
}

function cleanSemverSpec(spec: string | undefined): string {
  if (!spec) return 'unknown'
  return spec.replace(/^[~^>=<\s]+/, '') || 'unknown'
}

function findTailwindV4Import(root: string): string | undefined {
  for (const relFile of listWorkspaceFiles(root)) {
    if (!/\.css$/i.test(relFile)) continue
    const text = readTextCapped(join(root, ...relFile.split('/')), 50_000)
    if (text && /@import\s+["']tailwindcss["']/.test(text)) return relFile
  }
  return undefined
}

/** v3 is detected by a config file; v4 by `@import "tailwindcss"` in a stylesheet — the two ship genuinely different config surfaces, so config-file presence alone would misdetect a v4 project. */
function detectTailwind(
  root: string,
  pkg: PackageJsonShape | undefined,
  warnings: ProbeWarning[],
): { version: string; configPath: string } | null {
  if (!pkg || !hasDependency(pkg, 'tailwindcss')) return null
  const declaredSpec = pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss
  const version = () => resolveInstalledVersion(root, 'tailwindcss') ?? cleanSemverSpec(declaredSpec)

  const v3Config = findConfigFile(root, TAILWIND_CONFIG_NAMES)
  if (v3Config) return { version: version(), configPath: v3Config }

  const v4Import = findTailwindV4Import(root)
  if (v4Import) return { version: version(), configPath: v4Import }

  warnings.push({
    code: 'tailwind-config-not-found',
    message: 'tailwindcss is a dependency but neither a v3 config file nor a v4 `@import "tailwindcss"` was found in any stylesheet.',
    fix: 'Add a tailwind.config.{js,ts} (v3) or an `@import "tailwindcss";` line to your entry CSS (v4).',
  })
  return null
}

function hasCssModules(root: string): boolean {
  return listWorkspaceFiles(root).some((f) => /\.module\.(css|scss|sass|less)$/i.test(f))
}

function hasSass(root: string, pkg: PackageJsonShape | undefined): boolean {
  if (pkg && (hasDependency(pkg, 'sass') || hasDependency(pkg, 'node-sass'))) return true
  return listWorkspaceFiles(root).some((f) => /\.(scss|sass)$/i.test(f))
}

function detectCssInJs(pkg: PackageJsonShape | undefined): 'styled-components' | 'emotion' | 'stitches' | null {
  if (!pkg) return null
  if (hasDependency(pkg, 'styled-components')) return 'styled-components'
  if (hasDependency(pkg, '@emotion/react') || hasDependency(pkg, '@emotion/styled')) return 'emotion'
  if (hasDependency(pkg, '@stitches/react')) return 'stitches'
  return null
}

/**
 * `root` (the project's resolved app root, absolute) + its `package.json` ->
 * the whole `ProjectProfile['styleToolchain']` shape. Every path field
 * (`tailwind.configPath`, `postcssConfigPath`) is relative to `root` — the
 * caller (`probeProject`) re-prefixes with `appRoot` before storing, exactly
 * as it did when this logic lived inline.
 */
export function detectStyleToolchain(
  root: string,
  pkg: PackageJsonShape | undefined,
  warnings: ProbeWarning[],
): ProjectProfile['styleToolchain'] {
  const tailwind = detectTailwind(root, pkg, warnings)
  const postcssConfigPath = findConfigFile(root, POSTCSS_CONFIG_NAMES)
  return {
    tailwind,
    cssModules: hasCssModules(root),
    sass: hasSass(root, pkg),
    postcssConfigPath: postcssConfigPath ?? null,
    cssInJs: detectCssInJs(pkg),
  }
}
