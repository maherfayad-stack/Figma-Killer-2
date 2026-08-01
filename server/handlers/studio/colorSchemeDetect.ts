/**
 * colorSchemeDetect — WS-10 §3.1's `ColorSchemeCapability` detector, split
 * out of `projectProbe.ts` purely to stay under the module-size-budget
 * ceiling (same reasoning `tokenExtractTailwind.ts` gives for its own split
 * off `tokenExtract.ts`). Purely syntactic — a text scan, never an
 * execution, same posture as every other detector in `projectProbe.ts`.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
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

/**
 * Detects how (if at all) this project expresses dark mode — see
 * `ColorSchemeCapabilitySchema`'s doc for the three outcomes and why the
 * canvas needs to tell them apart. `'class'` is checked first: a project that
 * ships BOTH a class toggle and an incidental `prefers-color-scheme` media
 * query (rare, but Tailwind's own generated utilities can include one) is
 * still driven by its class toggle, which is the one the canvas can force
 * regardless of host OS preference without a CSS rewrite.
 */
export function detectColorScheme(root: string): ColorSchemeCapability {
  const tailwindConfig = findConfigFile(root, TAILWIND_CONFIG_NAMES)
  if (tailwindConfig) {
    const configText = readTextCapped(join(root, tailwindConfig), 200_000)
    if (configText && TAILWIND_DARK_MODE_CLASS_RE.test(configText)) {
      return { mechanism: 'class', selector: '.dark' }
    }
  }

  let sawMediaDark = false
  for (const relFile of listWorkspaceFiles(root)) {
    if (!/\.(css|scss|sass|less)$/i.test(relFile)) continue
    const text = readTextCapped(join(root, ...relFile.split('/')), 200_000)
    if (!text) continue
    const classMatch = DARK_CLASS_SELECTOR_RE.exec(text) ? '.dark' : DATA_THEME_SELECTOR_RE.exec(text)?.[0]
    if (classMatch) return { mechanism: 'class', selector: classMatch }
    if (!sawMediaDark && PREFERS_COLOR_SCHEME_DARK_RE.test(text)) sawMediaDark = true
  }
  if (sawMediaDark) return { mechanism: 'media' }
  return { mechanism: 'none' }
}
