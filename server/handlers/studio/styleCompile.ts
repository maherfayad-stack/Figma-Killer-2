/**
 * styleCompile — WS-2.1 of `STUDIO-IMPORT-V2-PLAN.md`: `dir + ProjectProfile
 * -> CompiledStyles`. Today an imported repo's styling arrives only if it is
 * plain CSS reached by a relative import (`studioCss.ts`'s existing,
 * unchanged path). This module is what makes Tailwind, Sass, PostCSS, and CSS
 * Modules arrive too — by RUNNING the workspace's own toolchain rather than
 * reimplementing it. A Tailwind config, a PostCSS pipeline, and a Sass import
 * graph are programs; a hand-rolled approximation drifts the moment a plugin
 * is used.
 *
 * Two very different trust postures live in this one file, split cleanly:
 *
 *   - **CSS Modules is Tier 0 (`static`) safe.** `transformCssModuleText`
 *     below is OUR OWN code — a small, deterministic class-name scoper. It
 *     never resolves, requires, or executes anything from the workspace, so
 *     it runs unconditionally, even on a project that has never been
 *     promoted past the "nothing runs" trust tier.
 *   - **Sass/Less/PostCSS/Tailwind is Tier 1.** Compiling them means running
 *     the WORKSPACE's own installed `sass`/`postcss` package and, for
 *     PostCSS, the workspace's own `postcss.config.*` — a config file is an
 *     arbitrary JS module that can do anything Node/Bun code can do.
 *     `meta-03` decision 1 fixed the default trust tier at `'static'` for
 *     every fresh import specifically so that importing a repo does not, by
 *     itself, run any of it. This module never auto-promotes: at Tier 0 it
 *     returns a `style-toolchain-requires-trust-promotion` warning instead of
 *     compiling, and the promote affordance lives in the UI surface that
 *     shows that warning. `compileSass`/`compilePostcssPipeline` themselves
 *     live in `styleCompileTier1.ts` (split out to stay under the module-size
 *     budget) — see that file's doc for `sec-01`'s subprocess design in full.
 *
 * The output feeds the EXISTING `cssToStyleRules` engine
 * (`studioCss.ts`/`@core/studio-sync`) — `StyleRule` ids, the class registry,
 * and the editor's whole styling surface stay exactly as they are. This is
 * one new PRODUCER for an existing consumer, not a second styling system.
 *
 * Compiled once per distinct input, cached under `.studio/cache/styles-
 * <hash>.{css,json}` — the `.css` file is the human-inspectable artefact, the
 * `.json` sidecar is what is actually read back (it round-trips
 * `moduleClassMaps`, which a `.css` file alone cannot carry).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { joinAppRoot } from './appRoot'
import { DEFAULT_TRUST_TIER, readStudioMeta, type TrustTier } from './studioMeta'
import { CSS_MODULE_FILE_RE, readCappedFile } from './styleCompileFileRead'
import { compileSass, compilePostcssPipeline, type StyleCompileOverrides } from './styleCompileTier1'
import type { ProbeWarning, ProjectProfile } from './projectProfileSchema'

export interface CompiledStyles {
  /** Compiled CSS text — CSS Modules (rewritten selectors) + Sass/PostCSS/Tailwind output, concatenated. Fed to `cssToStyleRules` alongside the plain-CSS path, never in place of it. */
  css: string
  /** `{ workspaceRelativePosixPath: { localClassName: generatedGlobalClassName } }` — one entry per `*.module.css` file. See `src/core/page-parser/assetImports.ts`'s `resolveCssModuleImport`, the evaluator-side consumer. */
  moduleClassMaps: Record<string, Record<string, string>>
  /**
   * WS-2.3 — raw CSS read from package `.css` files reached via a bare-
   * specifier import (`import '@acme/ui/dist/style.css'`). Concatenated,
   * UNMODIFIED bytes, in NO relation to `css`/`moduleClassMaps` above: never
   * parsed through `cssToStyleRules`, never contributes a `StyleRule`, never
   * enters the editable class registry. The client injects it as its own
   * read-only cascade-layer bucket — see `ProjectCssInjector`.
   */
  vendorCss: string
}

export interface StyleCompileResult {
  styles: CompiledStyles
  warnings: ProbeWarning[]
}

const EMPTY_STYLES: CompiledStyles = { css: '', moduleClassMaps: {}, vendorCss: '' }

const CACHE_DIR_SEGMENTS = ['.studio', 'cache'] as const

// ---------------------------------------------------------------------------
// CSS Modules — Tier 0, our own code, executes nothing (§2.2 of the plan)
// ---------------------------------------------------------------------------

const CSS_MODULE_PLAIN_CSS_RE = /\.module\.css$/i

function moduleFileBase(relPath: string): string {
  return basename(relPath).replace(CSS_MODULE_FILE_RE, '')
}

function hashLocalClass(relPath: string, localName: string): string {
  return createHash('sha1').update(`${relPath}:${localName}`).digest('hex').slice(0, 5)
}

/**
 * Matches, in order: a `:global(...)` wrapper (contents passed through
 * unchanged — CSS Modules' own escape hatch for a name that must NOT be
 * scoped), a quoted string (passed through — `content: '.foo'` must not be
 * mistaken for a selector), or a class-selector token. Only the last
 * alternative has a capture group with a value, which is how the replacer
 * below tells "rename this" from "leave alone."
 */
const PRELUDE_TOKEN_RE = /:global\(([^)]*)\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g

function renamePrelude(text: string, relPath: string, fileBase: string, classMap: Record<string, string>): string {
  return text.replace(PRELUDE_TOKEN_RE, (match, globalInner: string | undefined, className: string | undefined) => {
    if (globalInner !== undefined) return `:global(${globalInner})`
    if (className === undefined) return match // a quoted string — untouched
    let globalName = classMap[className]
    if (!globalName) {
      globalName = `${fileBase}_${className}__${hashLocalClass(relPath, className)}`
      classMap[className] = globalName
    }
    return `.${globalName}`
  })
}

/**
 * A minimal, self-contained CSS Modules transform — "the class-name hash rule
 * is stable and small," per the plan's §2.1, rather than shelling out to the
 * workspace's own `postcss-modules` (which would make plain `.module.css`
 * support depend on a Tier 1 trust promotion for no reason: nothing here
 * requires or executes workspace code).
 *
 * Walks the CSS text tracking brace depth WITHOUT a full CSS parser: every
 * span of text immediately before a `{` is a "prelude" (a selector, or an
 * at-rule condition like `@media (...)` — either way, safe to scan for class
 * tokens), and every span immediately before a `}` is a declaration body,
 * copied verbatim. A `/* ... *\/` comment is skipped as one unit so a brace
 * inside it can't desync the depth count. Known gaps (documented, not
 * silently wrong): `composes: x from './other.module.css'` is not resolved,
 * and a literal `{`/`}` inside a quoted attribute-selector value would
 * desync depth — neither shape appears in the fixtures this was built
 * against, and both are narrower than what a real `postcss-modules` run
 * would handle.
 */
export function transformCssModuleText(css: string, relPath: string): { css: string; classMap: Record<string, string> } {
  const classMap: Record<string, string> = {}
  const fileBase = moduleFileBase(relPath)
  let out = ''
  let buffer = ''
  let i = 0
  const n = css.length
  while (i < n) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const commentEnd = end === -1 ? n : end + 2
      buffer += css.slice(i, commentEnd)
      i = commentEnd
      continue
    }
    const ch = css[i]
    if (ch === '{') {
      out += renamePrelude(buffer, relPath, fileBase, classMap) + '{'
      buffer = ''
      i++
      continue
    }
    if (ch === '}') {
      out += buffer + '}'
      buffer = ''
      i++
      continue
    }
    buffer += ch
    i++
  }
  out += buffer // trailing content after the last brace, if any
  return { css: out, classMap }
}

/**
 * Compiles every `*.module.css` file in the workspace (Tier 0 — see this
 * module's doc). `.module.scss`/`.module.sass`/`.module.less` are a
 * documented, honest gap: they need Sass/Less compilation FIRST (Tier 1)
 * before the same renamer could apply, and this slice does not wire that —
 * see `docs/features/studio-import.md`'s "what still does not import."
 */
function compileCssModules(dir: string, warnings: ProbeWarning[]): { css: string; moduleClassMaps: Record<string, Record<string, string>> } {
  const files = listWorkspaceFiles(dir).sort()
  const moduleClassMaps: Record<string, Record<string, string>> = {}
  const chunks: string[] = []
  let sassModuleCount = 0

  for (const relPath of files) {
    if (!CSS_MODULE_FILE_RE.test(relPath)) continue
    if (!CSS_MODULE_PLAIN_CSS_RE.test(relPath)) {
      sassModuleCount++
      continue
    }
    const text = readCappedFile(join(dir, ...relPath.split('/')))
    if (text === undefined) continue
    const { css: rewritten, classMap } = transformCssModuleText(text, relPath)
    moduleClassMaps[relPath] = classMap
    chunks.push(`/* studio: css module ${relPath} */\n${rewritten}`)
  }

  if (sassModuleCount > 0) {
    warnings.push({
      code: 'css-module-sass-not-supported',
      message: `${sassModuleCount} \`.module.scss\`/\`.module.sass\`/\`.module.less\` file(s) were found. Only plain \`.module.css\` is compiled today.`,
      fix: 'Convert the file to plain CSS, or wait for Sass CSS Modules support.',
    })
  }

  return { css: chunks.join('\n\n'), moduleClassMaps }
}

// ---------------------------------------------------------------------------
// Vendor package CSS — WS-2.3, Tier 0 safe (a text scan + a file read, no
// code execution — unlike Sass/PostCSS/Tailwind below, this never needs
// `sec-01`'s subprocess).
// ---------------------------------------------------------------------------

/**
 * Matches a bare-specifier `.css` import: `import '@acme/ui/dist/style.css'`
 * or `import styles from 'pkg/style.css'`. Relative (`./x.css`) and absolute
 * specifiers are filtered out by the caller, which is also where a trailing
 * `?query` gets stripped before resolution.
 */
const BARE_CSS_IMPORT_RE = /import\s+(?:[\w*${},\s]+\s+from\s+)?['"]([^'"]+\.css)['"]/g

/**
 * Every bare-specifier `.css` import specifier reached from the workspace's
 * own JS/TS/JSX/TSX source — a plain text scan, not an AST walk:
 * `compileProjectStyles` runs BEFORE any page is parsed (WS-2.1's ordering
 * constraint — `moduleClassMaps` has to exist before `parsePageFile` does),
 * so there is no ts-morph `Project` in scope yet to walk import declarations
 * with, the way `collectPageStylesheets`/`collectEntryStylesheets` do once
 * parsing has happened. Deduped; relative/absolute specifiers and a
 * package's own `.module.css` (out of scope — see `compileCssModules`)
 * excluded here so the caller only ever sees real package specifiers.
 */
function findBareCssImportSpecifiers(dir: string): Set<string> {
  const files = listWorkspaceFiles(dir).filter((f) => /\.(tsx?|jsx?)$/i.test(f)).sort()
  const specifiers = new Set<string>()
  for (const relPath of files) {
    const text = readCappedFile(join(dir, ...relPath.split('/')))
    if (text === undefined) continue
    for (const match of text.matchAll(BARE_CSS_IMPORT_RE)) {
      const specifier = match[1]!
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue // relative/absolute — not a package
      if (CSS_MODULE_FILE_RE.test(specifier)) continue // a package's own CSS Modules file — out of scope
      specifiers.add(specifier)
    }
  }
  return specifiers
}

/** Splits a bare specifier into its npm package name (handling scoped `@scope/name`) and the remaining subpath — `@acme/ui/dist/style.css` -> `{ pkgName: '@acme/ui', subpath: 'dist/style.css' }`. */
function packageNameAndSubpath(specifier: string): { pkgName: string; subpath: string } {
  const parts = specifier.split('/')
  if (specifier.startsWith('@') && parts.length >= 2) {
    return { pkgName: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') }
  }
  return { pkgName: parts[0] ?? specifier, subpath: parts.slice(1).join('/') }
}

/**
 * `<appRootAbs>/node_modules/<pkgName>/<subpath>`, or `undefined` when the
 * package isn't installed, the import has no subpath (a bare
 * `import 'some-css-pkg'` with no file — nothing to read), the resolved path
 * escapes the package's own directory, or the file doesn't exist. Never
 * falls back to the host admin server's own `node_modules` — same posture as
 * every other resolver in this file. `appRootAbs` is the project's APP ROOT
 * (`approot-01` — `joinAppRoot`), not necessarily the project directory —
 * a nested app (`journey-screens/`) installs its own `node_modules` there.
 */
function resolvePackageCssPath(appRootAbs: string, specifier: string): string | undefined {
  const withoutQuery = specifier.split('?')[0]!
  const { pkgName, subpath } = packageNameAndSubpath(withoutQuery)
  if (!subpath) return undefined
  const pkgRoot = join(appRootAbs, 'node_modules', ...pkgName.split('/'))
  const absPath = join(pkgRoot, ...subpath.split('/'))
  const rel = relative(pkgRoot, absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return existsSync(absPath) ? absPath : undefined
}

/**
 * Resolves and reads every specifier `findBareCssImportSpecifiers` found,
 * concatenating the RAW bytes — never parsed, never rewritten, never fed to
 * `cssToStyleRules`. `specifiers` empty is the common case (most projects
 * import no package CSS) and returns `''` with no `node_modules` check at
 * all. Degrades to a warning, never throws, matching this module's contract.
 * `appRootAbs` — see `resolvePackageCssPath`'s doc.
 */
function collectVendorCss(appRootAbs: string, specifiers: ReadonlySet<string>, warnings: ProbeWarning[]): string {
  if (specifiers.size === 0) return ''

  if (!existsSync(join(appRootAbs, 'node_modules'))) {
    warnings.push({
      code: 'vendor-css-requires-install',
      message: `${specifiers.size} package stylesheet import(s) were found (e.g. \`${[...specifiers][0]}\`), but the workspace has no installed node_modules.`,
      fix: 'Run dependency install (POST /admin/api/studio/install), then reload.',
    })
    return ''
  }

  const chunks: string[] = []
  const unresolved: string[] = []
  for (const specifier of [...specifiers].sort()) {
    const absPath = resolvePackageCssPath(appRootAbs, specifier)
    const text = absPath ? readCappedFile(absPath) : undefined
    if (text === undefined) {
      unresolved.push(specifier)
      continue
    }
    chunks.push(`/* studio: vendor ${specifier} */\n${text}`)
  }
  if (unresolved.length > 0) {
    warnings.push({
      code: 'vendor-css-not-resolved',
      message: `${unresolved.length} package stylesheet import(s) could not be resolved: ${unresolved.join(', ')}.`,
      fix: 'Confirm the package is installed and the import path is correct, then reload.',
    })
  }
  return chunks.join('\n\n')
}

// ---------------------------------------------------------------------------
// Cache — content-hash keyed, `.studio/cache/styles-<hash>.{css,json}`
// ---------------------------------------------------------------------------

function cacheFilePaths(dir: string, cacheKey: string): { css: string; json: string } {
  const cacheDir = join(dir, ...CACHE_DIR_SEGMENTS)
  return { css: join(cacheDir, `styles-${cacheKey}.css`), json: join(cacheDir, `styles-${cacheKey}.json`) }
}

/**
 * Fingerprints every file whose content could change the compile output:
 * every stylesheet, every `postcss`/`tailwind` config, and — only when
 * Tailwind is in play — every JS/TS/JSX/TSX source file, because Tailwind's
 * JIT output depends on which utility classes appear ANYWHERE those content
 * globs reach. Stat-based (`size:mtimeMs`), not content-hashed: cheap enough
 * to run on every load, and a coarser cache key that over-invalidates is the
 * safe direction to be wrong in — the alternative (stale Tailwind output
 * silently missing a newly-used utility class) is not.
 */
function computeStyleCacheKey(dir: string, profile: ProjectProfile, trust: TrustTier, hasVendorCssCandidates: boolean): string {
  const toolchain = profile.styleToolchain
  const relevant = listWorkspaceFiles(dir).filter((relPath) => {
    if (/\.(css|scss|sass|less)$/i.test(relPath)) return true
    if (/^(postcss|tailwind)\.config\.(js|cjs|mjs|ts)$/i.test(basename(relPath))) return true
    // Only when Tailwind's JIT output depends on it, OR when a bare-specifier
    // `.css` import was found (WS-2.3) — that scan itself depends on every
    // JS/TS/JSX/TSX file's content, so the cache must invalidate when one of
    // them changes (e.g. an import line edited) just as much as when a
    // stylesheet does.
    return (Boolean(toolchain.tailwind) || hasVendorCssCandidates) && /\.(tsx?|jsx?)$/i.test(relPath)
  })

  const fingerprint = relevant.sort().map((relPath) => {
    try {
      const stat = statSync(join(dir, ...relPath.split('/')))
      return `${relPath}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return `${relPath}:missing`
    }
  })

  const hash = createHash('sha1')
  hash.update(trust)
  hash.update(JSON.stringify(toolchain))
  hash.update(fingerprint.join('\n'))
  return hash.digest('hex').slice(0, 16)
}

function readStyleCache(dir: string, cacheKey: string): CompiledStyles | undefined {
  const { json } = cacheFilePaths(dir, cacheKey)
  if (!existsSync(json)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(json, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const css = (parsed as Record<string, unknown>).css
    const moduleClassMaps = (parsed as Record<string, unknown>).moduleClassMaps
    const vendorCss = (parsed as Record<string, unknown>).vendorCss
    if (typeof css !== 'string' || !moduleClassMaps || typeof moduleClassMaps !== 'object') return undefined
    // Older cache entries (written before WS-2.3) have no `vendorCss` key —
    // treat as empty rather than invalidating every existing cache file.
    if (vendorCss !== undefined && typeof vendorCss !== 'string') return undefined
    return {
      css,
      moduleClassMaps: moduleClassMaps as Record<string, Record<string, string>>,
      vendorCss: typeof vendorCss === 'string' ? vendorCss : '',
    }
  } catch {
    return undefined
  }
}

function writeStyleCache(dir: string, cacheKey: string, styles: CompiledStyles): void {
  const { css, json } = cacheFilePaths(dir, cacheKey)
  try {
    mkdirSync(dirname(css), { recursive: true })
    writeFileSync(css, styles.css)
    writeFileSync(json, JSON.stringify(styles))
  } catch (err) {
    console.error('[studio:styleCompile] failed to write style cache', err)
  }
}

// ---------------------------------------------------------------------------
// compileProjectStyles — the entry point
// ---------------------------------------------------------------------------

/**
 * `dir + ProjectProfile -> CompiledStyles`, per §WS-2.1. Never throws:
 * anything that fails degrades to an empty contribution plus a warning,
 * matching the parser's own "unresolved, never a crash" contract, because a
 * broken style toolchain must not take the whole workspace load down.
 *
 * Returns `EMPTY_STYLES` immediately, with no filesystem work beyond the
 * cheap toolchain check, when the profile shows nothing this module handles
 * (a plain-CSS-only project keeps working through `studioCss.ts`'s existing,
 * completely separate path).
 *
 * `overrides` is a test seam only (`StyleCompileOverrides` — inject a fake
 * `spawn`/timers for `sec-01`'s adversarial subprocess tests); every real
 * caller (`studioPageLoad.ts`) omits it and gets the real `Bun.spawn`/timers.
 */
export async function compileProjectStyles(
  dir: string,
  profile: ProjectProfile,
  overrides: StyleCompileOverrides = {},
): Promise<StyleCompileResult> {
  const warnings: ProbeWarning[] = []
  const toolchain = profile.styleToolchain
  const needsCssModules = toolchain.cssModules
  const needsTier1 = Boolean(toolchain.sass || toolchain.tailwind || toolchain.postcssConfigPath)
  // WS-2.3 — vendor package CSS has no toolchain flag of its own (the probe
  // never scanned for it), so "is there anything to do" can't be answered
  // from `profile` alone the way CSS Modules/Tailwind/Sass can. The scan
  // itself needs no trust promotion (see `findBareCssImportSpecifiers`'s
  // doc), so it always runs, even at Tier 0.
  const vendorSpecifiers = findBareCssImportSpecifiers(dir)
  if (!needsCssModules && !needsTier1 && vendorSpecifiers.size === 0) return { styles: EMPTY_STYLES, warnings }

  // `approot-01` — every `node_modules` read (the Tier 1 gate below, vendor
  // CSS, the compiler resolution `compileSass`/`compilePostcssPipeline` do)
  // targets the project's APP ROOT, not necessarily the project directory:
  // a nested app installs its own `node_modules` there. `''` app root (the
  // common case) makes this a no-op — `appRootAbs === dir`.
  const appRootAbs = joinAppRoot(dir, profile.appRoot)
  const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
  const hasNodeModules = existsSync(join(appRootAbs, 'node_modules'))

  if (needsTier1) {
    if (trust === 'static') {
      warnings.push({
        code: 'style-toolchain-requires-trust-promotion',
        message: "This project uses Sass/PostCSS/Tailwind, which means running the workspace's own compiler — real code execution. The project is at Tier 0 (static), which never runs code.",
        fix: 'Promote this project to a trust tier that allows running its style toolchain, then reload.',
      })
    } else if (!hasNodeModules) {
      warnings.push({
        code: 'dependencies-not-installed',
        message: "Sass/PostCSS/Tailwind compilation needs the workspace's own installed compiler, but node_modules is missing.",
        fix: 'Run dependency install (POST /admin/api/studio/install), then reload.',
      })
    }
  }

  const cacheKey = computeStyleCacheKey(dir, profile, trust, vendorSpecifiers.size > 0)
  const cached = readStyleCache(dir, cacheKey)
  if (cached) return { styles: cached, warnings }

  const cssModulesResult = needsCssModules
    ? compileCssModules(dir, warnings)
    : { css: '', moduleClassMaps: {} as Record<string, Record<string, string>> }

  let tier1Css = ''
  if (needsTier1 && trust !== 'static' && hasNodeModules) {
    const sassCss = toolchain.sass ? await compileSass(dir, appRootAbs, warnings, overrides) : ''
    const postcssCss = toolchain.tailwind || toolchain.postcssConfigPath ? await compilePostcssPipeline(dir, appRootAbs, profile, warnings, overrides) : ''
    tier1Css = [sassCss, postcssCss].filter(Boolean).join('\n\n')
  }

  const styles: CompiledStyles = {
    css: [cssModulesResult.css, tier1Css].filter(Boolean).join('\n\n'),
    moduleClassMaps: cssModulesResult.moduleClassMaps,
    vendorCss: collectVendorCss(appRootAbs, vendorSpecifiers, warnings),
  }

  writeStyleCache(dir, cacheKey, styles)
  return { styles, warnings }
}
