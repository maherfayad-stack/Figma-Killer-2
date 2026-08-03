/**
 * designSystemDigest — the seventh generated reference file
 * (`agentRoster.ts`'s `buildReferenceFiles`): `design-system.md`, a MAP of a
 * project's own design-system CSS, not the CSS itself.
 *
 * ## The problem this fixes
 *
 * Every Studio chat turn against a project with a design system, the agent
 * re-reads the whole thing from raw CSS — `ls` the styles dir, then every
 * token file (`colors.css`, `semantic.css`, `typography.css`, `spacing.css`,
 * `rounded.css`, `elevation.css`), then every component file (`Button.css`,
 * `Navbar.css`, …). For the real `@alm-design/design-system` corpus that is
 * 46 files / 171 KB read cold, on every single turn, before any work starts.
 * `almosafer-ds-expert`'s embedded `CLAUDE.md`/`design.md` (`agentRoster.ts`)
 * covers the PROSE half of this — but only when the package is a real
 * `node_modules` install; a project whose design system arrived as a plain
 * CSS copy (`styles/imported/<slug>/`, no `package.json` at all) has no
 * `CLAUDE.md` to embed, and even a real install's `FrameworkSettings` token
 * extraction has no home for two whole families (`--rounded-*`, `--elevation-*`)
 * or for a single component's class name / variant surface.
 *
 * This module builds one compact markdown file instead: every token family
 * (colors, typography, spacing, radius, elevation) plus a one-line-per-
 * component index (class name, variants, source file) — built from the SAME
 * engine `tokenExtract.ts`'s `project-css`/`vendor-css` sources already use
 * (`tokenExtractCssScan.ts`'s `collectRootScopeMaps`/`classifyDeclaration`),
 * never a new CSS parser. It is a MAP, not the CSS: every line names the file
 * to open for the exact rule, so a real edit still reads the real source —
 * this only removes the "read 46 files just to find out what exists" cost
 * that happens BEFORE any real edit.
 *
 * Works whether or not `.studio/framework.json` was ever generated (that
 * file is `tokenExtract.ts`'s OWN persisted `FrameworkSettings` output, a
 * different artefact with a different shape) — this module reads the design
 * system's CSS files directly, every time, so a project where token
 * extraction never ran (`esim-journey` has no `.studio/framework.json` at
 * all) still gets a real digest.
 *
 * Cached under `.studio/cache/design-system-<hash>.md`, the same
 * content-hash-keyed convention `styleCompile.ts` uses for
 * `.studio/cache/styles-<hash>.{css,json}` — `.studio/cache/` is gitignored,
 * so this is disposable, regenerable-on-demand output, never committed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { readTextCapped } from './cappedFileRead'
import { classifyDeclaration, collectRootScopeMaps, resolveVarValue, toPx } from './tokenExtractCssScan'
import type { DesignSystemRef } from './projectProfileSchema'

const CACHE_DIR_SEGMENTS = ['.studio', 'cache'] as const

// ---------------------------------------------------------------------------
// CSS discovery — a bounded directory walk, NOT `listWorkspaceFiles`
// ---------------------------------------------------------------------------

/**
 * `listWorkspaceFiles` (`@core/page-parser`) skips any directory literally
 * named `dist` — correct for "don't treat build output as app source", wrong
 * here: a real `node_modules` package's ONLY css is routinely
 * `dist/index.css` (confirmed against the real `@alm-design/design-system`
 * install). So this is its own small, bounded walk: skip `node_modules`
 * (a design system's own nested one, if any) and `.git`, keep everything
 * else, collect only `.css` files. Never a CSS parser — just directory
 * listing, the classification below is what reuses the shared engine.
 */
const CSS_DISCOVERY_EXCLUDED_DIRS = new Set(['node_modules', '.git'])
const MAX_CSS_FILES_PER_SYSTEM = 300
const MAX_CSS_FILE_BYTES = 2_000_000

function listCssFilesUnder(absRoot: string): string[] {
  const out: string[] = []

  function walk(dir: string, rel: string): void {
    if (out.length >= MAX_CSS_FILES_PER_SYSTEM) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_CSS_FILES_PER_SYSTEM) return
      if (entry.isSymbolicLink()) continue
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (CSS_DISCOVERY_EXCLUDED_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), entryRel)
        continue
      }
      if (entry.isFile() && /\.css$/i.test(entry.name)) out.push(entryRel)
    }
  }

  walk(absRoot, '')
  return out.sort()
}

// ---------------------------------------------------------------------------
// Component index — BEM block/variant extraction from class selectors
// ---------------------------------------------------------------------------

interface BlockEntry {
  variants: Set<string>
  files: Set<string>
}

/** A class-selector token — `.btn`, `.btn--primary`, `.btn__icon`. No `:global(...)`/quoted-string exclusion needed here (unlike `styleCompile.ts`'s prelude scan): a false-positive class name inside a quoted `content: '.foo'` value only ever adds one harmless, orphaned "block" with zero variants. */
const CLASS_SELECTOR_RE = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g

/**
 * Strips the two shapes of CSS text that would otherwise mint a fake ".css"
 * block: a `/* ... *\/` comment mentioning a sibling filename ("see
 * `Button.css`") and an `@import './colors.css';` statement — both contain a
 * literal `.css` substring that `CLASS_SELECTOR_RE` cannot tell apart from a
 * real class selector on text alone. Real class selectors are never inside
 * either construct, so stripping both first is lossless for the block scan.
 */
function stripCssNoiseForBlockScan(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '')
}

/**
 * Every BEM "block" (a class with no `--`/`__` of its own — `.btn`, not
 * `.btn--primary` or `.btn__icon`) found in `cssText`, with the modifier
 * suffixes (`--primary`, `--size-default`, …) that appear alongside it and
 * the file it came from. This is the "class name + available variants" half
 * of the component index — deliberately inclusive (a stray non-component
 * utility class becomes one extra harmless line) rather than lossy: the
 * digest's whole job is to never quietly drop a real variant.
 */
function collectBlocks(cssText: string, relFile: string, into: Map<string, BlockEntry>): void {
  const cleaned = stripCssNoiseForBlockScan(cssText)
  const names = new Set<string>()
  CLASS_SELECTOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CLASS_SELECTOR_RE.exec(cleaned)) !== null) names.add(m[1]!)

  for (const block of names) {
    if (block.includes('--') || block.includes('__')) continue
    const entry = into.get(block) ?? { variants: new Set<string>(), files: new Set<string>() }
    entry.files.add(relFile)
    const prefix = `${block}--`
    for (const name of names) {
      if (name.startsWith(prefix)) entry.variants.add(name.slice(block.length))
    }
    into.set(block, entry)
  }
}

// ---------------------------------------------------------------------------
// Token classification — reuses `tokenExtractCssScan`'s engine; adds only the
// two families `FrameworkSettings` has no home for (radius, elevation).
// ---------------------------------------------------------------------------

interface DigestTokens {
  colorCount: number
  colorPrefixCounts: Map<string, number>
  spacing: { name: string; px: number }[]
  radius: { name: string; px: number }[]
  typographySizes: { name: string; px: number }[]
  typographyDetailCount: number
  elevationNames: string[]
  unclassifiedCount: number
}

function emptyDigestTokens(): DigestTokens {
  return {
    colorCount: 0,
    colorPrefixCounts: new Map(),
    spacing: [],
    radius: [],
    typographySizes: [],
    typographyDetailCount: 0,
    elevationNames: [],
    unclassifiedCount: 0,
  }
}

/** `--rounded-*`/`--radius-*` — not matched by `classifyDeclaration`'s own spacing name hint (`SPACING_NAME_HINT_RE` matches the literal substring "radius", not "rounded", the convention real design systems actually ship), which is exactly why `FrameworkSettings` has never had a radius family. */
const RADIUS_NAME_RE = /round|radius/i
/** `--elevation-*`/`--*-shadow` — a shadow value is a multi-part shorthand (`0px -4px 16px rgba(...)`), never a single color literal, so it always falls through `classifyDeclaration` as `unclassified` today. Checked by NAME, not value, for the same reason `classifyDeclaration` checks radius by hint after the color check: a shadow's resolved value has no single shape to test. */
const ELEVATION_NAME_RE = /shadow|elevation/i

/** Classifies one `:root`-scope declaration for the digest — radius/elevation first (by name, see the regexes above), then delegates to `classifyDeclaration` for color/spacing/typography, exactly as `classifyCssText` does. */
function classifyForDigest(name: string, light: ReadonlyMap<string, string>, tokens: DigestTokens): void {
  const raw = light.get(name)!
  const resolved = resolveVarValue(raw, light)

  if (RADIUS_NAME_RE.test(name)) {
    const px = toPx(resolved)
    if (px !== null) {
      tokens.radius.push({ name, px })
      return
    }
  }
  if (ELEVATION_NAME_RE.test(name)) {
    tokens.elevationNames.push(name)
    return
  }

  const kind = classifyDeclaration(name, resolved)
  if (kind === 'color') {
    tokens.colorCount++
    const prefix = name.replace(/^--/, '').split('-')[0] || 'other'
    tokens.colorPrefixCounts.set(prefix, (tokens.colorPrefixCounts.get(prefix) ?? 0) + 1)
    return
  }
  if (kind === 'spacing') {
    const px = toPx(resolved)
    if (px !== null) tokens.spacing.push({ name, px })
    else tokens.unclassifiedCount++
    return
  }
  if (kind === 'typography-size') {
    const px = toPx(resolved)
    if (px !== null) tokens.typographySizes.push({ name, px })
    else tokens.typographyDetailCount++
    return
  }
  if (kind === 'typography-detail') {
    tokens.typographyDetailCount++
    return
  }
  tokens.unclassifiedCount++
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderDigestMarkdown(
  designSystems: readonly DesignSystemRef[],
  tokens: DigestTokens,
  blocks: ReadonlyMap<string, BlockEntry>,
): string {
  const lines: string[] = []
  lines.push('# Design system reference')
  lines.push('')
  lines.push(
    `Generated from this project's own design-system CSS (${designSystems.map((d) => d.name).join(', ')}) — ` +
      'a MAP of the tokens and components, not the CSS itself. Regenerated on every ' +
      'chat turn from a content hash of the underlying files; do not hand-edit. Every ' +
      'line below names the file to open for the exact rule, selector, or dark-mode override.',
  )
  lines.push('')

  lines.push(`## Colors (${tokens.colorCount} tokens)`)
  lines.push('')
  if (tokens.colorPrefixCounts.size > 0) {
    const breakdown = [...tokens.colorPrefixCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([prefix, count]) => `${prefix}(${count})`)
      .join(', ')
    lines.push(`By name prefix: ${breakdown}.`)
    lines.push('')
  }
  lines.push(
    'Reach for the semantic name that matches intent (`--text-warning-default`, ' +
      '`--background-primary-hover`, …) over a raw palette value — open the token ' +
      'file(s) for exact hex/rgba.',
  )
  lines.push('')

  lines.push(`## Typography (${tokens.typographySizes.length} size steps, ${tokens.typographyDetailCount} detail tokens)`)
  lines.push('')
  if (tokens.typographySizes.length > 0) {
    lines.push(
      [...tokens.typographySizes]
        .sort((a, b) => a.px - b.px)
        .map((t) => `${t.name}: ${t.px}px`)
        .join(', '),
    )
    lines.push('')
  }
  lines.push('Detail tokens (family/weight/line-height/letter-spacing) are counted, not listed by value — open the token file for the exact pairing.')
  lines.push('')

  lines.push(`## Spacing (${tokens.spacing.length} tokens)`)
  lines.push('')
  if (tokens.spacing.length > 0) {
    lines.push([...tokens.spacing].sort((a, b) => a.px - b.px).map((t) => `${t.name}: ${t.px}px`).join(', '))
    lines.push('')
  }

  lines.push(`## Radius (${tokens.radius.length} tokens)`)
  lines.push('')
  if (tokens.radius.length > 0) {
    lines.push([...tokens.radius].sort((a, b) => a.px - b.px).map((t) => `${t.name}: ${t.px}px`).join(', '))
    lines.push('')
  }

  lines.push(`## Elevation / shadow (${tokens.elevationNames.length} tokens)`)
  lines.push('')
  if (tokens.elevationNames.length > 0) {
    lines.push([...tokens.elevationNames].sort().join(', '))
    lines.push('')
    lines.push('Values are multi-part shadow strings — open the token file rather than guessing one.')
    lines.push('')
  }

  if (tokens.unclassifiedCount > 0) {
    lines.push(`${tokens.unclassifiedCount} other custom properties were found but did not fit any family above — open the token files directly for those.`)
    lines.push('')
  }

  const sortedBlocks = [...blocks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  lines.push(`## Components (${sortedBlocks.length})`)
  lines.push('')
  for (const [block, entry] of sortedBlocks) {
    const variants = [...entry.variants].sort()
    const files = [...entry.files].sort().join(', ')
    const variantText = variants.length > 0 ? ` — variants: ${variants.join(', ')}` : ''
    lines.push(`- .${block}${variantText} — ${files}`)
  }
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// buildDesignSystemDigest — the pure builder
// ---------------------------------------------------------------------------

/**
 * `dir + DesignSystemRef[] -> markdown | undefined`. `undefined` when there
 * are no design systems to document, or none of them yielded a single
 * readable `.css` file — never throws, matching every other module in this
 * folder's "degrade, don't crash the turn" contract.
 */
export function buildDesignSystemDigest(dir: string, designSystems: readonly DesignSystemRef[]): string | undefined {
  if (designSystems.length === 0) return undefined

  const cssTexts: string[] = []
  const blocks = new Map<string, BlockEntry>()

  for (const ds of designSystems) {
    const absRoot = join(dir, ...ds.root.split('/'))
    for (const relFile of listCssFilesUnder(absRoot)) {
      const text = readTextCapped(join(absRoot, ...relFile.split('/')), MAX_CSS_FILE_BYTES)
      if (text === undefined) continue
      cssTexts.push(text)
      collectBlocks(text, `${ds.root}/${relFile}`, blocks)
    }
  }

  if (cssTexts.length === 0) return undefined

  const { light } = collectRootScopeMaps(cssTexts.join('\n\n'))
  const tokens = emptyDigestTokens()
  for (const name of light.keys()) classifyForDigest(name, light, tokens)

  return renderDigestMarkdown(designSystems, tokens, blocks)
}

// ---------------------------------------------------------------------------
// Cache — content-hash keyed, `.studio/cache/design-system-<hash>.md`, the
// same convention `styleCompile.ts` uses for `styles-<hash>.{css,json}`.
// ---------------------------------------------------------------------------

function cacheFilePath(dir: string, cacheKey: string): string {
  return join(dir, ...CACHE_DIR_SEGMENTS, `design-system-${cacheKey}.md`)
}

/**
 * Fingerprints every `.css` file under every design system's root
 * (stat-based — `size:mtimeMs`, the same coarse-but-cheap fingerprint
 * `styleCompile.ts`'s `computeStyleCacheKey` uses) so a changed design system
 * regenerates structurally rather than on a TTL guess. Cheap to run on every
 * chat turn: a `readdirSync` walk plus a `statSync` per file, no file content
 * read.
 *
 * Exported so `agentRoster.ts`'s own regeneration fingerprint (perf-06) can
 * fold "did the design system's CSS change" into ONE cheap check without
 * also paying for `getOrBuildDesignSystemDigest`'s cache-file read — the
 * roster generator only needs to know whether it changed, not (yet) the
 * digest content itself.
 */
export function computeDesignSystemCacheKey(dir: string, designSystems: readonly DesignSystemRef[]): string {
  const hash = createHash('sha1')
  for (const ds of [...designSystems].sort((a, b) => a.root.localeCompare(b.root))) {
    const absRoot = join(dir, ...ds.root.split('/'))
    hash.update(`${ds.source}:${ds.name}:${ds.root}`)
    for (const relFile of listCssFilesUnder(absRoot)) {
      try {
        const stat = statSync(join(absRoot, ...relFile.split('/')))
        hash.update(`${relFile}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        hash.update(`${relFile}:missing`)
      }
    }
  }
  return hash.digest('hex').slice(0, 16)
}

function readDigestCache(dir: string, cacheKey: string): string | undefined {
  return readTextCapped(cacheFilePath(dir, cacheKey), 1_000_000)
}

function writeDigestCache(dir: string, cacheKey: string, content: string): void {
  const file = cacheFilePath(dir, cacheKey)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  } catch (err) {
    console.error('[studio:designSystemDigest] failed to write cache', err)
  }
}

/**
 * The one entry point every real caller (`agentRoster.ts`) uses: cached,
 * content-hash-keyed digest of every design system this project has.
 * `undefined` when there is nothing to document (no design systems detected,
 * or none had a readable `.css` file) — `buildReferenceFiles` treats that as
 * "no seventh file this turn", not an error.
 */
export function getOrBuildDesignSystemDigest(dir: string, designSystems: readonly DesignSystemRef[]): string | undefined {
  if (designSystems.length === 0) return undefined

  const cacheKey = computeDesignSystemCacheKey(dir, designSystems)
  const cached = readDigestCache(dir, cacheKey)
  if (cached !== undefined) return cached

  const built = buildDesignSystemDigest(dir, designSystems)
  if (built === undefined) return undefined

  writeDigestCache(dir, cacheKey, built)
  return built
}

/** Test seam only — lets `designSystemDigest.test.ts` assert cache-file existence without depending on `existsSync` import order in the module under test. */
export function designSystemCacheFileExists(dir: string, designSystems: readonly DesignSystemRef[]): boolean {
  return existsSync(cacheFilePath(dir, computeDesignSystemCacheKey(dir, designSystems)))
}
