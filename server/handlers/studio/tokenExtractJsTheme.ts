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
import type { JsThemeEntry, TokenFamily } from '@core/studio-tokens'
import { extractJsonTokens, extractJsTokens, type ExtractedCssVar } from '../designImport/parseCssTokens'
import { classifyDeclaration, emptyClassifiedTokens, toPx, type ClassifiedTokens } from './tokenExtractCssScan'
import { readCappedFile } from './styleCompileFileRead'
import { ThemeFileReader, type StaticValue } from './tokenJsThemeStatic'

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

// ---------------------------------------------------------------------------
// The Variables panel's read-only rows (CT-6)
// ---------------------------------------------------------------------------

/**
 * `extractJsThemeTokens` above feeds Studio's FRAMEWORK scales (a classified
 * palette to import). The Variables panel wants something else from the same
 * files: every value a JavaScript theme defines, where it is written, and the
 * utility classes that apply it - as read-only rows. A Tailwind v3 config's
 * `theme.extend.colors.primary` has no `--name` and no CSS to edit; it is a
 * class vocabulary (`bg-primary`), so that is what the row offers.
 *
 * Parse only (`tokenJsThemeStatic.ts`): the config is never run, so a value it
 * computes (a `require`d palette, a function of `theme`, a spread of a
 * package) is listed as computed with the reason, not guessed.
 */
const TAILWIND_CONFIG_RE = /^tailwind\.config\.(?:js|cjs|mjs|ts|mts|cts)$/i
const MAX_CONFIG_FILES = 3
const MAX_ENTRIES = 800
const MAX_NESTING = 4

interface ThemeGroup {
  readonly family: TokenFamily
  /** Tailwind utility prefixes that read an entry of this group. */
  readonly utilities: readonly string[]
}

/** The `theme` keys Studio lists, with the utilities that apply them. Others (`screens`, `animation`...) are not values a panel can apply to an element. */
const THEME_GROUPS: Readonly<Record<string, ThemeGroup>> = {
  colors: { family: 'color', utilities: ['bg', 'text', 'border', 'fill', 'stroke', 'ring', 'outline'] },
  backgroundColor: { family: 'color', utilities: ['bg'] },
  textColor: { family: 'color', utilities: ['text'] },
  borderColor: { family: 'color', utilities: ['border'] },
  spacing: { family: 'space', utilities: ['p', 'm', 'gap', 'w', 'h'] },
  fontSize: { family: 'type', utilities: ['text'] },
  fontFamily: { family: 'type', utilities: ['font'] },
  fontWeight: { family: 'type', utilities: ['font'] },
  lineHeight: { family: 'type', utilities: ['leading'] },
  letterSpacing: { family: 'type', utilities: ['tracking'] },
  borderRadius: { family: 'radius', utilities: ['rounded'] },
  boxShadow: { family: 'shadow', utilities: ['shadow'] },
}

/** Names a standalone token file uses for a group Tailwind calls something else. */
const GROUP_ALIASES: Readonly<Record<string, string>> = { palette: 'colors', colours: 'colors', color: 'colors', radii: 'borderRadius', radius: 'borderRadius', shadows: 'boxShadow' }

function groupNamed(name: string): { group: string; spec: ThemeGroup } | null {
  const group = THEME_GROUPS[name] ? name : GROUP_ALIASES[name]
  return group && THEME_GROUPS[group] ? { group, spec: THEME_GROUPS[group] } : null
}

/** The sentence a read-only row shows: exactly why the value is not edited here, and what to do instead. */
function readOnlyReason(entry: { file: string; line: number; why: string | null; applyAs: string | undefined; fromConfig: boolean; opaque: boolean }): string {
  const where = `${entry.file}:${entry.line}`
  const apply = entry.applyAs ? ` You can still apply it to an element with a class such as ${entry.applyAs}.` : ''
  if (entry.opaque) {
    return `${where} pulls in more values than Studio can list (${entry.why}). Studio reads your theme without running it, so it cannot show or change those. Edit them in ${entry.file}.`
  }
  if (entry.why) {
    return `Computed in ${where} (${entry.why}), so its value is only known by running your code, which Studio never does. Edit it in ${entry.file}.${apply}`
  }
  if (!entry.fromConfig) {
    return `Written in ${where}. No Tailwind config in this project reads that file, so Studio has no class that applies it, and it does not run code to rewrite it. Edit it in ${entry.file}, or declare it as a CSS variable.`
  }
  return `Written in ${where}, a JavaScript file Studio reads without running, so it does not change the value from here. Edit it in ${entry.file}.${apply}`
}

interface EntryContext {
  readonly entries: Map<string, JsThemeEntry>
  /** The entries came from a Tailwind config, so its classes exist. */
  readonly fromConfig: boolean
  readonly configFile: string
}

/** Tailwind's tuple forms read as one value: `fontSize: ['1rem', { lineHeight }]` is `1rem`, `fontFamily: ['Inter', 'sans-serif']` is the list. */
function scalarOfArray(value: Extract<StaticValue, { kind: 'array' }>): string | null {
  const plain = value.items.filter((item) => item.kind !== 'object')
  const strings = plain.flatMap((item) => (item.kind === 'string' ? [item.value] : []))
  return strings.length > 0 && strings.length === plain.length ? strings.join(', ') : null
}

function rawOf(value: StaticValue): string {
  return value.kind === 'object' ? '{...}' : value.raw
}

function addEntry(context: EntryContext, group: string, spec: ThemeGroup, path: string[], classKey: string, value: StaticValue): void {
  if (context.entries.size >= MAX_ENTRIES) return
  const why = value.kind === 'computed' ? value.why : value.kind === 'array' ? (value.items.find((item): item is Extract<StaticValue, { kind: 'computed' }> => item.kind === 'computed')?.why ?? null) : null
  const utilities = context.fromConfig && classKey.length > 0 ? spec.utilities.map((utility) => `${utility}-${classKey}`) : []
  const id = `${value.file}#${group}.${path.join('.')}`
  context.entries.set(id, {
    id,
    file: value.file,
    line: value.line,
    source: value.file === context.configFile ? 'tailwind-config' : 'theme-file',
    group,
    path: path.join('.'),
    family: spec.family,
    raw: rawOf(value),
    value: value.kind === 'string' ? value.value : value.kind === 'array' ? scalarOfArray(value) : null,
    utilities,
    readOnlyReason: readOnlyReason({ file: value.file, line: value.line, why, applyAs: utilities[0], fromConfig: context.fromConfig, opaque: false }),
  })
}

function addOpaque(context: EntryContext, group: string, spec: ThemeGroup, path: string[], opaque: { file: string; line: number; why: string; raw: string }): void {
  const id = `${opaque.file}#${[group, ...path, '*'].join('.')}:${opaque.line}`
  context.entries.set(id, {
    id,
    file: opaque.file,
    line: opaque.line,
    source: opaque.file === context.configFile ? 'tailwind-config' : 'theme-file',
    group,
    path: [...path, '*'].join('.'),
    family: spec.family,
    raw: opaque.raw,
    value: null,
    utilities: [],
    readOnlyReason: readOnlyReason({ file: opaque.file, line: opaque.line, why: opaque.why, applyAs: undefined, fromConfig: context.fromConfig, opaque: true }),
  })
}

function walkGroup(context: EntryContext, group: string, spec: ThemeGroup, value: StaticValue, path: string[]): void {
  if (value.kind !== 'object') {
    // `primary: { DEFAULT: '#...', 500: '#...' }` -> classes `primary` and `primary-500`.
    const classPath = path.filter((segment, index) => !(segment === 'DEFAULT' && index === path.length - 1))
    addEntry(context, group, spec, path, classPath.join('-'), value)
    return
  }
  if (path.length >= MAX_NESTING) {
    addEntry(context, group, spec, path, '', { kind: 'computed', why: 'it nests deeper than Studio lists', raw: '{...}', file: value.file, line: value.line })
    return
  }
  for (const entry of value.entries) walkGroup(context, group, spec, entry.value, [...path, entry.key])
  for (const opaque of value.opaque) addOpaque(context, group, spec, path, opaque)
}

function readGroups(context: EntryContext, container: StaticValue): void {
  if (container.kind !== 'object') return
  for (const entry of container.entries) {
    const match = groupNamed(entry.key)
    if (match) walkGroup(context, match.group, match.spec, entry.value, [])
  }
}

/** The config's `theme` and `theme.extend`: replace-style keys first, extend-style last so a later key of the same name wins. */
function readTailwindConfig(reader: ThemeFileReader, configFile: string, entries: Map<string, JsThemeEntry>): void {
  const config = reader.evaluateDefault(configFile)
  if (config?.kind !== 'object') return
  const theme = config.entries.findLast((entry) => entry.key === 'theme')?.value
  if (theme?.kind !== 'object') return
  const context: EntryContext = { entries, fromConfig: true, configFile }
  readGroups(context, theme)
  const extend = theme.entries.findLast((entry) => entry.key === 'extend')?.value
  if (extend) readGroups(context, extend)
}

/** A token file no Tailwind config reads: each exported object that is a theme (has group keys), or is one group (`export const colors = {...}`). */
function readStandaloneThemeFile(reader: ThemeFileReader, relPath: string, entries: Map<string, JsThemeEntry>): void {
  const context: EntryContext = { entries, fromConfig: false, configFile: '' }
  for (const exported of reader.evaluateExports(relPath)) {
    const asGroup = groupNamed(exported.name)
    if (asGroup) {
      walkGroup(context, asGroup.group, asGroup.spec, exported.value, [])
      continue
    }
    readGroups(context, exported.value)
    // A wrapper such as `export const theme = { extend: { colors } }`.
    const extend = exported.value.kind === 'object' ? exported.value.entries.findLast((entry) => entry.key === 'extend')?.value : undefined
    if (extend) readGroups(context, extend)
  }
}

/**
 * Every value the project's JavaScript themes define: Tailwind v3 configs
 * (`tailwind.config.*`, with the token files they import) and standalone token
 * files (`theme.ts`, `tokens.js`...). Bounded, never throws, never runs code.
 */
export function extractJsThemeEntries(dir: string): JsThemeEntry[] {
  try {
    const configs = listWorkspaceFiles(dir)
      .filter((relPath) => relPath.split('/').length <= 3 && TAILWIND_CONFIG_RE.test(relPath.split('/').pop() ?? ''))
      .slice(0, MAX_CONFIG_FILES)
    const reader = new ThemeFileReader(dir)
    const entries = new Map<string, JsThemeEntry>()
    for (const config of configs) readTailwindConfig(reader, config, entries)
    const covered = new Set([...entries.values()].map((entry) => entry.file))
    for (const relPath of findJsThemeFileCandidates(dir)) {
      if (!/\.(?:ts|tsx|js|jsx)$/i.test(relPath) || covered.has(relPath) || configs.includes(relPath)) continue
      readStandaloneThemeFile(reader, relPath, entries)
    }
    return [...entries.values()]
  } catch (err) {
    console.error('[tokenExtractJsTheme] could not read the JavaScript themes; continuing without them:', err)
    return []
  }
}
