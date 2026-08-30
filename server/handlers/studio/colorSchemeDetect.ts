/**
 * colorSchemeDetect — WS-10 §3.1's `ColorSchemeCapability` detector, split
 * out of `projectProbe.ts` purely to stay under the module-size-budget
 * ceiling (same reasoning `tokenExtractTailwind.ts` gives for its own split
 * off `tokenExtract.ts`). Purely syntactic — a text scan, never an
 * execution, same posture as every other detector in `projectProbe.ts`.
 *
 * ## Why it also reads `node_modules`
 *
 * The scan used to walk `listWorkspaceFiles(root)` alone, which excludes
 * `node_modules` by policy. That made it structurally blind to the single
 * most common way a real project expresses dark mode: it doesn't. Its
 * DESIGN SYSTEM does, in the package stylesheet the project imports by bare
 * specifier and Studio already injects into every canvas frame as
 * `@layer vendor` (`ProjectCssInjector.tsx`). `@alm-design/design-system` is
 * exactly this — `:root[data-theme=dark]`, `:root:not([data-theme=light])`
 * and six `prefers-color-scheme:dark` blocks, none of them in a file this
 * probe could see. Such a project reported `mechanism: 'none'`, so Studio's
 * dark-mode toggle rendered DISABLED with "no dark-mode stylesheet was
 * detected" and `studio_project_profile` told the agent the same thing —
 * both false, about a project whose every component is dark-mode capable.
 *
 * So the scan now runs in two passes, project-first:
 *
 *   1. the project's OWN stylesheets (`listWorkspaceFiles`, unchanged), then
 *   2. the stylesheets shipped by its installed component packages.
 *
 * The order is the precedence: a project that ships its own gate is driven by
 * its own gate, and a package's mechanism is only reported when the project
 * itself declares none. `source` names which one won, so a disabled/enabled
 * control and an agent reading the profile can both say WHERE the mechanism
 * came from instead of asserting it from nowhere.
 */
import { join, relative, sep } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { listWorkspaceFiles } from '@core/page-parser'
import { readTextCapped } from './cappedFileRead'
import type { ColorSchemeCapability } from './projectProfileSchema'

const TAILWIND_CONFIG_NAMES = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'] as const

function findConfigFile(root: string, names: readonly string[]): string | undefined {
  return names.find((name) => existsSync(join(root, name)))
}

/** `.dark` as a genuine class-selector token, not a substring of a longer class name (`.darkened`). */
const DARK_CLASS_SELECTOR_RE = /\.dark(?![\w-])/
/** `[data-theme="dark"]` / `[data-scheme="dark"]` — requires the literal `dark` value, not just the attribute name, or a project that only styles `[data-theme="light"]` would be misdetected as if that were the dark-mode gate. Captures the exact selector text as reported to the caller. */
const DATA_THEME_SELECTOR_RE = /\[data-(?:theme|scheme)\s*=\s*["']?dark["']?\]/i
/** Tailwind v3's `darkMode: 'class' | 'selector'` config key, plain or array form (`darkMode: ['class', '.dark-mode']`). */
const TAILWIND_DARK_MODE_CLASS_RE = /darkMode\s*:\s*(?:['"](class|selector)['"]|\[\s*['"](class|selector)['"])/

/**
 * `@media (prefers-color-scheme: dark)` — tolerant of extra whitespace and
 * case, but requires the condition to be exactly this single feature (not,
 * e.g., `(min-width: 768px) and (prefers-color-scheme: dark)`), matching
 * exactly the pattern `darkSchemeCssTransform.ts` knows how to rewrite. A
 * project whose ONLY dark-mode media query is compound still reports `'none'`
 * here — a false negative is the honest failure mode (WS-10 §7.4), not a
 * mechanism the canvas can't actually apply.
 */
const PREFERS_COLOR_SCHEME_DARK_RE = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i

const STYLESHEET_RE = /\.(css|scss|sass|less)$/i
const MAX_STYLESHEET_BYTES = 200_000

/**
 * Where a package keeps its built stylesheet. A package root is not walked
 * recursively — a design system's `node_modules` entry can hold thousands of
 * files, and no package ships its distributable CSS more than one level deep
 * under a conventional output directory. `''` is the package root itself
 * (`style.css` beside `package.json`, the pattern `package.json#style`
 * points at).
 */
const PACKAGE_CSS_DIRS = ['', 'dist', 'build', 'lib', 'es', 'esm', 'styles', 'css'] as const

/** Ceiling on how many package stylesheets one probe reads, so a pathological dependency cannot turn a probe into a directory walk. */
const MAX_PACKAGE_STYLESHEETS = 24

/** Every `.css`/`.scss`/`.sass`/`.less` file directly inside `absDir`, sorted for a stable, reproducible probe result. Never throws — an absent or unreadable directory contributes nothing. */
function listStylesheetsIn(absDir: string): string[] {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STYLESHEET_RE.test(entry.name))
      .map((entry) => join(absDir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** The stylesheets an installed package ships, looked for only in the conventional places (`PACKAGE_CSS_DIRS`) and capped at `MAX_PACKAGE_STYLESHEETS`. */
function listPackageStylesheets(appRootAbs: string, packageName: string): string[] {
  const pkgRoot = join(appRootAbs, 'node_modules', ...packageName.split('/'))
  if (!existsSync(pkgRoot)) return []
  const files: string[] = []
  for (const dir of PACKAGE_CSS_DIRS) {
    for (const file of listStylesheetsIn(dir ? join(pkgRoot, dir) : pkgRoot)) {
      files.push(file)
      if (files.length >= MAX_PACKAGE_STYLESHEETS) return files
    }
  }
  return files
}

/** The dark-mode gate a single stylesheet's text declares, or `undefined` when it declares none. A class gate wins over a media query within one file for the same reason it wins across files — see `detectColorScheme`. */
function gateInStylesheet(text: string): { kind: 'class'; selector: string } | { kind: 'media' } | undefined {
  const selector = DARK_CLASS_SELECTOR_RE.exec(text) ? '.dark' : DATA_THEME_SELECTOR_RE.exec(text)?.[0]
  if (selector) return { kind: 'class', selector }
  if (PREFERS_COLOR_SCHEME_DARK_RE.test(text)) return { kind: 'media' }
  return undefined
}

/** Scans one ordered group of stylesheets: the first class gate found wins outright; a media gate is remembered but only reported when no class gate exists anywhere in the group. */
function scanStylesheets(files: Iterable<{ abs: string; source: string }>): ColorSchemeCapability | undefined {
  let media: ColorSchemeCapability | undefined
  for (const { abs, source } of files) {
    const text = readTextCapped(abs, MAX_STYLESHEET_BYTES)
    if (!text) continue
    const gate = gateInStylesheet(text)
    if (!gate) continue
    if (gate.kind === 'media') {
      media ??= { mechanism: 'media', source }
      continue
    }
    return { mechanism: 'class', selector: gate.selector, source }
  }
  return media
}

/**
 * Detects how (if at all) this project expresses dark mode — see
 * `ColorSchemeCapabilitySchema`'s doc for the three outcomes and why the
 * canvas needs to tell them apart. `'class'` is checked first: a project that
 * ships BOTH a class toggle and an incidental `prefers-color-scheme` media
 * query (rare, but Tailwind's own generated utilities can include one) is
 * still driven by its class toggle, which is the one the canvas can force
 * regardless of host OS preference without a CSS rewrite.
 *
 * `componentPackages` is the list `detectComponentPackages` already computed
 * for the same profile — pass it so a project whose dark mode lives entirely
 * in its design system is reported honestly (see the module doc). Omitting
 * it scans the project's own files only, which is what a caller with no
 * package list can truthfully claim.
 */
export function detectColorScheme(root: string, componentPackages: readonly string[] = []): ColorSchemeCapability {
  const tailwindConfig = findConfigFile(root, TAILWIND_CONFIG_NAMES)
  if (tailwindConfig) {
    const configText = readTextCapped(join(root, tailwindConfig), MAX_STYLESHEET_BYTES)
    if (configText && TAILWIND_DARK_MODE_CLASS_RE.test(configText)) {
      return { mechanism: 'class', selector: '.dark', source: tailwindConfig }
    }
  }

  const projectFiles = (function* () {
    for (const relFile of listWorkspaceFiles(root)) {
      if (!STYLESHEET_RE.test(relFile)) continue
      yield { abs: join(root, ...relFile.split('/')), source: relFile }
    }
  })()
  const fromProject = scanStylesheets(projectFiles)
  // A project's own gate beats its design system's, even when the project's
  // is only a media query and the package ships a class toggle: the project
  // is what the published app actually runs under.
  if (fromProject) return fromProject

  const packageFiles = (function* () {
    for (const name of componentPackages) {
      for (const abs of listPackageStylesheets(root, name)) {
        yield { abs, source: relative(root, abs).split(sep).join('/') }
      }
    }
  })()
  return scanStylesheets(packageFiles) ?? { mechanism: 'none' }
}
