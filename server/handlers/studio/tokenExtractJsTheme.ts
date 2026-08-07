/**
 * tokenExtractJsTheme — `tokenExtract.ts`'s `js-theme` source
 * (`STUDIO-FIGMA-PARITY-PLAN.md` §11, Track H, T6): wires
 * `designImport/parseCssTokens.ts`'s `extractJsTokens`/`extractJsonTokens` —
 * built for the EXTERNAL npm/GitHub design-import wizard — into the
 * currently OPEN project too. Before this, an identical `theme.ts` classified
 * differently depending only on which side of an import boundary it sat on:
 * parsed when fetched from an npm package by the wizard, silently ignored
 * when it was the user's own file already sitting on disk.
 *
 * Scope, deliberately narrow (Tier 0 — no code execution, ever, matching
 * `extractJsTokens`'s own "text-only, never parsed as code" contract): only
 * files whose BASENAME reads as a design-token file (`theme`, `tokens`,
 * `design-tokens`, `colors`, `palette` — case-insensitive, `.ts`/`.tsx`/
 * `.js`/`.jsx`/`.json`) are read. A repo-wide scan of every JS/TS file
 * looking for object-literal shapes would be both slow and far too eager to
 * guess which file is really a token source; a real design-token file is
 * conventionally named one of these.
 */
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { extractJsonTokens, extractJsTokens, type ExtractedCssVar } from '../designImport/parseCssTokens'
import { classifyDeclaration, emptyClassifiedTokens, toPx, type ClassifiedTokens } from './tokenExtractCssScan'
import { readCappedFile } from './styleCompileFileRead'

const JS_THEME_FILENAME_RE = /^(theme|tokens|design-tokens|designtokens|colors|palette)\.(ts|tsx|js|jsx|json)$/i
/** Bound how many candidate files are read — generous for any real project's token file count, far below a pathological repo's total file count. */
const MAX_JS_THEME_FILES = 5

/** Every project file whose basename reads as a design-token file (see module doc), workspace-relative, sorted, capped at `MAX_JS_THEME_FILES`. Exported for its own test coverage. */
export function findJsThemeFileCandidates(dir: string): string[] {
  return listWorkspaceFiles(dir)
    .filter((relPath) => JS_THEME_FILENAME_RE.test(relPath.split('/').pop() ?? ''))
    .slice(0, MAX_JS_THEME_FILES)
}

function classifyVarsInto(vars: readonly ExtractedCssVar[], result: ClassifiedTokens): void {
  for (const v of vars) {
    const kind = classifyDeclaration(v.name, v.value)
    if (kind === 'color') {
      result.colors.push({ name: v.name, light: v.value })
    } else if (kind === 'spacing') {
      const px = toPx(v.value)
      if (px !== null) result.spacing.push({ name: v.name, px })
      else result.unclassifiedCount++
    } else if (kind === 'typography-size') {
      const px = toPx(v.value)
      if (px !== null) result.typographySizes.push({ name: v.name, px })
      else result.typographyDetailCount++
    } else if (kind === 'typography-detail') {
      result.typographyDetailCount++
    } else {
      result.unclassifiedCount++
    }
  }
}

/**
 * Reads every candidate file (`findJsThemeFileCandidates`, `relPaths` so the
 * caller can reuse a single discovery pass) and classifies its extracted
 * vars — JSON via `extractJsonTokens` (real `JSON.parse`, always safe),
 * JS/TS via `extractJsTokens` (text-only regex; the source is never parsed
 * as code, let alone executed).
 */
export function extractJsThemeTokens(dir: string, relPaths: readonly string[]): ClassifiedTokens {
  const result = emptyClassifiedTokens()
  for (const relPath of relPaths) {
    const text = readCappedFile(join(dir, ...relPath.split('/')))
    if (!text) continue
    if (relPath.toLowerCase().endsWith('.json')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue // malformed JSON — skip this file, not the whole scan
      }
      classifyVarsInto(extractJsonTokens(parsed, relPath), result)
    } else {
      classifyVarsInto(extractJsTokens(text, relPath), result)
    }
  }
  return result
}
