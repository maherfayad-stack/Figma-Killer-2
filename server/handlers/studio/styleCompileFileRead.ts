/**
 * styleCompileFileRead — the tiny, pure, no-dependency leaf shared by
 * `styleCompile.ts` (CSS Modules, WS-2.3 vendor CSS, the cache) and
 * `styleCompileTier1.ts` (Sass/PostCSS/Tailwind). Split out purely so those
 * two don't import from each other — a straight leaf dependency, not a
 * cycle.
 */
import { readFileSync, statSync } from 'node:fs'

/** A single input stylesheet larger than this is skipped rather than read. */
export const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

export const CSS_MODULE_FILE_RE = /\.module\.(css|scss|sass|less)$/i

export function readCappedFile(absPath: string): string | undefined {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > MAX_STYLESHEET_BYTES) return undefined
    return readFileSync(absPath, 'utf8')
  } catch {
    return undefined
  }
}
