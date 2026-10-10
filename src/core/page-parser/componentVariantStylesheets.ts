/**
 * componentVariantStylesheets — the stylesheet half of the variant binding
 * analyzer (`componentVariantBindings.ts`): which stylesheets a component
 * imports, the top-level rules in each, and which rule styles a given class or
 * `[data-attr="value"]`.
 *
 * Read-only and contained. Stylesheets are read through an injected
 * {@link StylesheetReader}; the default one is the file system but REFUSES any
 * path outside the workspace root, so an import specifier can never point the
 * analyzer at a file the project does not own. SCSS/Less that postcss cannot
 * parse as plain CSS yields no rules, which the analyzer reports as `opaque`
 * rather than guessing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import postcss from 'postcss'
import type { SourceFile } from 'ts-morph'
import type { SourceRange } from '@core/component-variants'

const STYLESHEET_RE = /\.(css|scss|sass|less)$/i

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Reads one stylesheet by ABSOLUTE path; `undefined` when it cannot be read. */
export type StylesheetReader = (absPath: string) => string | undefined

/** What the stylesheet reads need: the root they are contained to, the reader, and a per-component parse cache. */
export interface StylesheetAccess {
  readonly workspaceRoot: string
  readonly readStylesheet: StylesheetReader
  /** Parsed rules per stylesheet, so a component with three variant props parses each file once. */
  readonly ruleCache: Map<string, CssRuleLocation[]>
}

/** The default reader: the file system, but never outside `workspaceRoot`. */
export function readWorkspaceStylesheet(workspaceRoot: string): StylesheetReader {
  const root = resolve(workspaceRoot)
  return (absPath) => {
    const full = resolve(absPath)
    if (full !== root && !full.startsWith(root + sep)) return undefined
    if (!existsSync(full)) return undefined
    try {
      return readFileSync(full, 'utf8')
    } catch (_err) {
      // An unreadable stylesheet is "no rule found", which the analyzer already reports as opaque.
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Stylesheets the component imports
// ---------------------------------------------------------------------------

export interface ImportedStylesheet {
  absPath: string
  /** Local name of `import styles from './X.module.css'`; `undefined` for a side-effect import. */
  localName: string | undefined
  isModule: boolean
}

export function importedStylesheets(sourceFile: SourceFile): ImportedStylesheet[] {
  const found: ImportedStylesheet[] = []
  const dir = dirname(sourceFile.getFilePath())
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    if (!specifier.startsWith('.') || !STYLESHEET_RE.test(specifier)) continue
    const isModule = /\.module\.[a-z]+$/i.test(specifier)
    found.push({
      absPath: resolve(dir, specifier),
      localName: isModule ? declaration.getDefaultImport()?.getText() : undefined,
      isModule,
    })
  }
  return found
}

export interface CssRuleLocation {
  selectors: string[]
  range: SourceRange
  selectorText: string
}

/** The top-level rules of one stylesheet, with their spans. `[]` when unreadable or not parseable CSS. */
export function parseStylesheetRules(ctx: StylesheetAccess, absPath: string): CssRuleLocation[] {
  const cached = ctx.ruleCache.get(absPath)
  if (cached) return cached
  const rules = readStylesheetRules(ctx, absPath)
  ctx.ruleCache.set(absPath, rules)
  return rules
}

function readStylesheetRules(ctx: StylesheetAccess, absPath: string): CssRuleLocation[] {
  const text = ctx.readStylesheet(absPath)
  if (text === undefined) return []
  let root: postcss.Root
  try {
    root = postcss.parse(text)
  } catch (_err) {
    // Not parseable as plain CSS (SCSS/Less syntax): no rule can be claimed from it.
    return []
  }
  const file = toPosix(relative(ctx.workspaceRoot, absPath))
  const rules: CssRuleLocation[] = []
  root.each((child) => {
    if (child.type !== 'rule' || !child.source?.start || !child.source.end) return
    rules.push({
      selectors: child.selectors,
      selectorText: child.selector,
      range: {
        file,
        line: child.source.start.line,
        column: child.source.start.column,
        endLine: child.source.end.line,
        endColumn: child.source.end.column,
      },
    })
  })
  return rules
}

/** The last compound of a selector (`.card .btn.primary` -> `.btn.primary`); `undefined` when the selector has pseudo-state, so it is not the member's base rule. */
function baseCompound(selector: string): string | undefined {
  const compound = selector.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? ''
  return compound.includes(':') ? undefined : compound
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The first rule whose base compound carries `.className`. */
export function findClassRule(rules: readonly CssRuleLocation[], className: string): { selector: string; range: SourceRange } | undefined {
  const pattern = new RegExp(`(^|[^\\w-])\\.${escapeRegExp(className)}(?![\\w-])`)
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const compound = baseCompound(selector)
      if (compound !== undefined && pattern.test(compound)) return { selector, range: rule.range }
    }
  }
  return undefined
}

/** The first rule whose base compound carries `[attr="value"]` (or the bare `[attr]` for `true`). */
export function findAttrRule(
  rules: readonly CssRuleLocation[],
  attr: string,
  value: string,
): { selector: string; range: SourceRange } | undefined {
  const quoted = new RegExp(`\\[\\s*${escapeRegExp(attr)}\\s*=\\s*["']?${escapeRegExp(value)}["']?\\s*\\]`)
  const bare = new RegExp(`\\[\\s*${escapeRegExp(attr)}\\s*\\]`)
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const compound = baseCompound(selector)
      if (compound === undefined) continue
      if (quoted.test(compound) || (value === 'true' && bare.test(compound))) return { selector, range: rule.range }
    }
  }
  return undefined
}

