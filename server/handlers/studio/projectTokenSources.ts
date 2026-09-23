/**
 * projectTokenSources — the stylesheets a project's design tokens can come
 * from, collected in ONE place, each with the file it came from.
 *
 * "The same CSS the canvas gets" was written four times over — `studio_compare`,
 * `studio_measure_reference`, `studio_quality_check` and `studio_plan_variants`
 * each assembled `[builtinDesignSystemTokenCss(dir), vendorCss, css]` by hand —
 * and all four copies left out the one place a Vite app actually keeps its
 * tokens: the global stylesheet its entry module imports (`src/index.css`),
 * which `studioCss.ts` loads into the canvas FIRST, before any screen's own
 * CSS. The fifth reader, `studio_list_tokens`, needs one thing none of them
 * did — WHERE each token is declared — so the assembly moves here, once, with
 * provenance, and every reader goes through it (AI-4).
 *
 * ## Cascade order
 *
 * Sources are returned in the order the canvas cascades them, so a consumer
 * that lets a later declaration win (every consumer does) agrees with the
 * canvas about which value is live:
 *
 *   1. Studio's built-in design-system sheet, for a DS-backed project — the
 *      read-only `@layer vendor` bucket;
 *   2. package stylesheets reached through a bare-specifier import — the same
 *      bucket;
 *   3. `compileProjectStyles`' own output: CSS Modules chunks, then compiled
 *      Sass/PostCSS/Tailwind output;
 *   4. the global stylesheets reached from the app's entry module, in import
 *      order — the project's own hand-written token files. Last, so a token a
 *      Tailwind build ALSO emits is attributed to the file a person edits
 *      rather than to the compiler's output.
 *
 * What is NOT collected: a stylesheet imported only by one screen. Its
 * `:root` declarations do cascade on that screen, but they are not the
 * project's token layer, and finding them means parsing every page.
 *
 * ## Never throws
 *
 * Every source degrades on its own: a style toolchain that fails to compile
 * still leaves the entry stylesheets, and a missing entry still leaves the
 * compiled output. A token reader answering "no tokens" is a real answer; a
 * token reader that throws takes a whole measurement down with it.
 */
import { collectEntryStylesheets } from '@core/studio-sync/collectPageStylesheets'
import { resolveProjectProfile } from './projectProbe'
import type { TokenCssSource } from './projectTokenIndex'
import { compileProjectStyles, splitCompiledStyleChunks, type StyleChunk } from './styleCompile'
import { readCappedFile } from './styleCompileFileRead'
import { builtinDesignSystemTokenCss } from './tokenExtractPackageCss'
import { withWorkspaceProject } from './workspaceProject'

/** An entry stylesheet the token scan reads raw. `.scss`/`.less` need their compiler first (and arrive through step 3 when it runs); a CSS Module is step 3's too. */
const RAW_READABLE_STYLESHEET_RE = /(?<!\.module)\.css$/i

/** Studio's built-in design-system sheet, named the way the agent can find it — see `readBuiltinDesignSystemCss`. */
const BUILTIN_DESIGN_SYSTEM_FILE = 'vendor/alm-design-system/dist/index.css'

function chunkSource(chunk: StyleChunk): TokenCssSource {
  switch (chunk.kind) {
    case 'css module':
      return { file: chunk.label, origin: 'project', css: chunk.css }
    case 'vendor':
      return { file: chunk.label, origin: 'package', css: chunk.css }
    case 'compiled':
      return { file: chunk.label ? `compiled ${chunk.label} output` : 'compiled styles', origin: 'compiled', css: chunk.css }
  }
}

/**
 * The project's token-bearing stylesheets in canvas cascade order, each named
 * by the file it came from. See the module doc for what is and is not here.
 */
export async function collectProjectTokenSources(dir: string): Promise<TokenCssSource[]> {
  const sources: TokenCssSource[] = []

  const builtin = builtinDesignSystemTokenCss(dir)
  if (builtin) sources.push({ file: BUILTIN_DESIGN_SYSTEM_FILE, origin: 'studio-design-system', css: builtin })

  try {
    const compiled = await compileProjectStyles(dir, resolveProjectProfile(dir))
    for (const chunk of splitCompiledStyleChunks(compiled.styles.vendorCss)) sources.push(chunkSource(chunk))
    for (const chunk of splitCompiledStyleChunks(compiled.styles.css)) sources.push(chunkSource(chunk))
  } catch (err) {
    console.error('[projectTokenSources] could not compile project styles; continuing without them:', err)
  }

  try {
    const entrySheets = await withWorkspaceProject(dir, async (project) => collectEntryStylesheets(project, dir))
    for (const sheet of entrySheets) {
      if (!RAW_READABLE_STYLESHEET_RE.test(sheet.relPath)) continue
      const css = readCappedFile(sheet.absPath)
      if (css) sources.push({ file: sheet.relPath, origin: 'project', css })
    }
  } catch (err) {
    console.error('[projectTokenSources] could not collect the entry stylesheets; continuing without them:', err)
  }

  return sources
}

/** Just the CSS text, in the same order — what `buildProjectTokenIndex` and the font-availability scan take. */
export async function collectProjectTokenCss(dir: string): Promise<string[]> {
  return (await collectProjectTokenSources(dir)).map((source) => source.css)
}
