/**
 * tokenExtractScss — `tokenExtract.ts`'s `scss-vars` source
 * (`STUDIO-FIGMA-PARITY-PLAN.md` §11, Track H, T6): a Tier-0, non-compiling
 * reader for Sass `$variable: value;` declarations.
 *
 * A Sass variable never survives into compiled CSS as a custom property
 * unless the project explicitly re-exports it (`:root { --x: $x; }`) — so a
 * design system authored purely in `$variables` produced ZERO tokens
 * through every other source: `project-css` needs Tier-1 compilation to
 * even exist, and even then only a re-exported subset appears. This module
 * reads the DECLARED `$name: value;` pairs straight out of the SOURCE
 * text — Tier 0, no Sass compiler invoked — so the declared scale is at
 * least discoverable before a project is ever promoted to Tier 1.
 *
 * Deliberately shallow: only top-level (brace-depth 0) declarations are
 * read — a `$x` inside a mixin/function/nested selector is a LOCAL
 * variable, not a design token, and offering it in the picker would be a
 * name with no stable meaning outside that one rule. `@use`/`@forward`
 * namespacing, interpolation (`#{$x}`), and computed values (`$x: $a + $b`)
 * are not resolved — silently skipped rather than guessed, the same
 * posture `tokenExtractTailwind.ts` documents for a config built by
 * function/spread.
 */
import { listWorkspaceFiles } from '@core/page-parser'
import { classifyDeclaration, emptyClassifiedTokens, toPx, type ClassifiedTokens } from './tokenExtractCssScan'

/** Bound how many `.scss` files are read into one combined scan — generous for a real project's token-file count, far below a pathological repo's total `.scss` count. */
const MAX_SCSS_FILES = 40

/** Every `.scss` file under `dir` (workspace-relative, sorted, `node_modules`/`.git`/etc already excluded by `listWorkspaceFiles`), capped at `MAX_SCSS_FILES`. `.sass` indented syntax is not covered — real projects overwhelmingly use the `.scss` (SCSS) syntax this module's `{ }`/`;` scan assumes. */
export function findScssFileCandidates(dir: string): string[] {
  return listWorkspaceFiles(dir)
    .filter((relPath) => /\.scss$/i.test(relPath))
    .slice(0, MAX_SCSS_FILES)
}

/** `#comment` and `/* … *\/` stripped, mirroring `designImport/parseCssTokens.ts`'s `stripJsComments` (SCSS shares JS-style `//`/`/* *\/` comments). */
function stripScssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const SCSS_DECL_RE = /^\$([A-Za-z0-9_-]+)\s*:\s*([^;]+);/

/**
 * Extracts every top-level `$name: value;` from `scssText` and classifies
 * each through the shared `classifyDeclaration` engine — value first,
 * exactly like every other source. A value containing `$`/`#`/`@` (a
 * reference to another variable, interpolation, or an at-rule fragment) is
 * counted as unclassified rather than guessed at — this module never
 * resolves Sass expressions.
 */
export function extractScssVariableTokens(scssText: string): ClassifiedTokens {
  const result = emptyClassifiedTokens()
  if (!scssText) return result
  const cleaned = stripScssComments(scssText)

  let depth = 0
  let i = 0
  const n = cleaned.length
  while (i < n) {
    const ch = cleaned[i]
    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (depth === 0 && ch === '$') {
      const m = SCSS_DECL_RE.exec(cleaned.slice(i))
      if (m) {
        const name = m[1]!
        const value = m[2]!.trim()
        // Reject a reference to another variable (`$other`) or interpolation
        // (`#{...}`) — NOT a bare `#`, which is exactly how a hex colour
        // value starts (`#0c9ab0`) and must still classify normally.
        if (/\$|#\{/.test(value)) {
          result.unclassifiedCount++
        } else {
          const kind = classifyDeclaration(name, value)
          if (kind === 'color') result.colors.push({ name: `$${name}`, light: value })
          else if (kind === 'spacing') {
            const px = toPx(value)
            if (px !== null) result.spacing.push({ name: `$${name}`, px })
            else result.unclassifiedCount++
          } else if (kind === 'typography-size') {
            const px = toPx(value)
            if (px !== null) result.typographySizes.push({ name: `$${name}`, px })
            else result.typographyDetailCount++
          } else if (kind === 'typography-detail') {
            result.typographyDetailCount++
          } else {
            result.unclassifiedCount++
          }
        }
        i += m[0].length
        continue
      }
    }
    i++
  }

  return result
}
