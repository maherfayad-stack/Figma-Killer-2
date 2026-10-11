/**
 * tokenJsThemeStatic - reads the VALUE of a JavaScript theme expression
 * without running it (CT-6). The reader behind `tokenExtractJsTheme.ts`.
 *
 * A Tailwind v3 config and a `theme.ts` token file are JavaScript: their
 * values are object literals, constants, spreads, indexing, and now and then a
 * call. This module walks the SYNTAX TREE (`ts.createSourceFile` - the source
 * is parsed, never evaluated, imported or required) and answers one question
 * per expression: is its value written down, or is it computed?
 *
 *   - a string or number literal, an object literal, an array literal, a
 *     constant that is one of those (this file or a relative import of
 *     another), a member or index of one of those: WRITTEN. Read.
 *   - everything else - `require('...')`, a call, a function, a template with
 *     holes, a reference to a package (`colors.sky[500]` from
 *     `tailwindcss/colors`), a spread of any of those: COMPUTED. Reported as
 *     such, with why, and never guessed at. Reading `require('./palette')`
 *     would mean following a CommonJS load; the honest answer for that and
 *     for a function is "this needs running", so it is listed read-only with
 *     that reason instead of being half-read.
 *
 * Bounded: depth, total expressions visited and files parsed are capped, and
 * a cycle (`a = b; b = a`) ends as "computed". Never throws.
 */
import { join, posix } from 'node:path'
import { ts } from 'ts-morph'
import { readCappedFile } from './styleCompileFileRead'

/** Where a value is written. */
export interface StaticSite {
  readonly file: string
  readonly line: number
}

export type StaticValue =
  | ({ kind: 'string'; value: string; raw: string } & StaticSite)
  | ({ kind: 'object'; entries: StaticEntry[]; opaque: StaticOpaque[] } & StaticSite)
  | ({ kind: 'array'; items: StaticValue[]; raw: string } & StaticSite)
  | ({ kind: 'computed'; why: string; raw: string } & StaticSite)

export interface StaticEntry {
  readonly key: string
  readonly value: StaticValue
}

/** Something an object takes in that cannot be read (`...require('x')`): the keys it contributes are unknown. */
export interface StaticOpaque extends StaticSite {
  readonly why: string
  readonly raw: string
}

const MAX_DEPTH = 8
const MAX_VISITS = 6000
const MAX_FILES = 12
const MAX_RAW = 120
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs']
const TYPESCRIPT_RE = /\.(?:ts|mts|cts)$/i

interface ImportBinding {
  readonly specifier: string
  /** `default`, a named export, or `*` for a namespace import. */
  readonly imported: string
}

/** One parsed script file: its top-level constants, exports and imports. */
interface ParsedFile {
  readonly rel: string
  readonly source: ts.SourceFile
  readonly consts: Map<string, ts.Expression>
  readonly exports: Map<string, ts.Expression>
  readonly imports: Map<string, ImportBinding>
  /** `export default X` or `module.exports = X`. */
  defaultExport?: ts.Expression
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_RAW ? `${flat.slice(0, MAX_RAW - 3)}...` : flat
}

function isModuleExportsTarget(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports'
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

/** Parses files on demand, once each, and resolves relative imports inside the workspace. */
export class ThemeFileReader {
  private readonly parsed = new Map<string, ParsedFile | null>()
  private readonly dir: string
  private visits = 0

  constructor(dir: string) {
    this.dir = dir
  }

  /** Parses `rel` (workspace-relative, POSIX), or `null` when it is unreadable, too large, or past the file budget. */
  load(rel: string): ParsedFile | null {
    const cached = this.parsed.get(rel)
    if (cached !== undefined) return cached
    if (this.parsed.size >= MAX_FILES) return null
    const text = readCappedFile(join(this.dir, ...rel.split('/')))
    if (text === undefined) {
      this.parsed.set(rel, null)
      return null
    }
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, TYPESCRIPT_RE.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.TSX)
    const file: ParsedFile = { rel, source, consts: new Map(), exports: new Map(), imports: new Map() }
    this.index(file)
    this.parsed.set(rel, file)
    return file
  }

  private index(file: ParsedFile): void {
    for (const statement of file.source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
          file.consts.set(declaration.name.text, declaration.initializer)
          if (hasExportModifier(statement)) file.exports.set(declaration.name.text, declaration.initializer)
        }
      } else if (ts.isExportAssignment(statement)) {
        file.defaultExport = statement.expression
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExportsTarget(statement.expression.left)) {
        file.defaultExport = statement.expression.right
      } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const local = file.consts.get((element.propertyName ?? element.name).text)
          if (local) file.exports.set(element.name.text, local)
        }
      } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
        const specifier = statement.moduleSpecifier.text
        const clause = statement.importClause
        if (clause.name) file.imports.set(clause.name.text, { specifier, imported: 'default' })
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) file.imports.set(bindings.name.text, { specifier, imported: '*' })
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) file.imports.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text })
        }
      }
    }
  }

  /** The module a relative import names, inside the workspace, or `null` (a package, or outside the workspace). */
  private resolveImport(from: ParsedFile, specifier: string): ParsedFile | null {
    if (!specifier.startsWith('.')) return null
    const base = posix.normalize(posix.join(posix.dirname(from.rel), specifier))
    if (base.startsWith('..') || posix.isAbsolute(base)) return null
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = this.load(`${base}${extension}`)
      if (candidate) return candidate
    }
    return null
  }

  private site(file: ParsedFile, node: ts.Node): StaticSite {
    return { file: file.rel, line: file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1 }
  }

  private computed(file: ParsedFile, node: ts.Node, why: string): StaticValue {
    return { kind: 'computed', why, raw: oneLine(node.getText(file.source)), ...this.site(file, node) }
  }

  /** The value an exported binding of `file` holds, as the importer sees it. */
  private exported(file: ParsedFile, imported: string, depth: number): StaticValue | null {
    const expression = imported === 'default' ? file.defaultExport ?? file.exports.get('default') : file.exports.get(imported)
    return expression ? this.evaluate(file, expression, depth + 1) : null
  }

  /** The value of `expression`, written in `file`. */
  evaluate(file: ParsedFile, expression: ts.Expression, depth = 0): StaticValue {
    if (depth > MAX_DEPTH || ++this.visits > MAX_VISITS) return this.computed(file, expression, 'it is nested too deeply to follow')
    let node: ts.Expression = expression
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { kind: 'string', value: node.text, raw: oneLine(node.getText(file.source)), ...this.site(file, node) }
    }
    if (ts.isNumericLiteral(node)) return { kind: 'string', value: node.text, raw: node.text, ...this.site(file, node) }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
      return { kind: 'string', value: `-${node.operand.text}`, raw: oneLine(node.getText(file.source)), ...this.site(file, node) }
    }
    if (ts.isObjectLiteralExpression(node)) return this.evaluateObject(file, node, depth)
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map((element) => (ts.isSpreadElement(element) ? this.computed(file, element, 'it spreads another array') : this.evaluate(file, element, depth + 1)))
      return { kind: 'array', items, raw: oneLine(node.getText(file.source)), ...this.site(file, node) }
    }
    if (ts.isIdentifier(node)) return this.evaluateIdentifier(file, node, depth)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return this.evaluateMember(file, node, depth)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      return this.computed(file, node, 'it is loaded with require(), which only running the file can do')
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return this.computed(file, node, 'it is a function of the theme, which only running the config can answer')
    if (ts.isCallExpression(node)) return this.computed(file, node, 'it is the result of a function call')
    return this.computed(file, node, 'it is built by an expression')
  }

  private evaluateObject(file: ParsedFile, node: ts.ObjectLiteralExpression, depth: number): StaticValue {
    const entries: StaticEntry[] = []
    const opaque: StaticOpaque[] = []
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = this.propertyKey(property.name)
        if (key === null) opaque.push({ why: 'a key it computes', raw: oneLine(property.name.getText(file.source)), ...this.site(file, property) })
        else entries.push({ key, value: this.evaluate(file, property.initializer, depth + 1) })
      } else if (ts.isShorthandPropertyAssignment(property)) {
        entries.push({ key: property.name.text, value: this.evaluateIdentifier(file, property.name, depth + 1) })
      } else if (ts.isSpreadAssignment(property)) {
        const spread = this.evaluate(file, property.expression, depth + 1)
        if (spread.kind === 'object') {
          entries.push(...spread.entries)
          opaque.push(...spread.opaque)
        } else {
          opaque.push({ why: spread.kind === 'computed' ? spread.why : 'it spreads something that is not an object', raw: oneLine(property.getText(file.source)), ...this.site(file, property) })
        }
      } else {
        entries.push({ key: property.name?.getText(file.source) ?? '?', value: this.computed(file, property, 'it is a method') })
      }
    }
    return { kind: 'object', entries, opaque, ...this.site(file, node) }
  }

  private propertyKey(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) return name.expression.text
    return null
  }

  private evaluateIdentifier(file: ParsedFile, node: ts.Identifier, depth: number): StaticValue {
    const local = file.consts.get(node.text)
    if (local) return this.evaluate(file, local, depth + 1)
    const binding = file.imports.get(node.text)
    if (!binding) return this.computed(file, node, `${node.text} is not a constant this file declares`)
    const target = this.resolveImport(file, binding.specifier)
    if (!target) return this.computed(file, node, binding.specifier.startsWith('.') ? `${binding.specifier} could not be read` : `it comes from the package ${binding.specifier}, which Studio does not read`)
    if (binding.imported === '*') return this.computed(file, node, 'it is a whole module namespace')
    return this.exported(target, binding.imported, depth) ?? this.computed(file, node, `${binding.specifier} does not export ${binding.imported} as a constant`)
  }

  private evaluateMember(file: ParsedFile, node: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): StaticValue {
    const base = this.evaluate(file, node.expression, depth + 1)
    if (base.kind !== 'object') return this.computed(file, node, base.kind === 'computed' ? base.why : 'it indexes something that is not an object')
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) ? node.argumentExpression.text : null
    if (key === null) return this.computed(file, node, 'its key is computed')
    const entry = [...base.entries].reverse().find((candidate) => candidate.key === key)
    return entry ? entry.value : this.computed(file, node, `${key} is not a key the object spells out`)
  }

  /** The value a file exports as its configuration or token object (`module.exports = {...}`, `export default {...}`). */
  evaluateDefault(rel: string): StaticValue | null {
    const file = this.load(rel)
    if (!file) return null
    const expression = file.defaultExport ?? file.exports.get('default')
    if (!expression) return null
    // `defineConfig({...})`-style wrappers hand the object back unchanged; reading through one is not running it.
    let node: ts.Expression = expression
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isIdentifier(node.expression) && /^define[A-Z]/.test(node.expression.text)) {
      return this.evaluate(file, node.arguments[0]!)
    }
    return this.evaluate(file, expression)
  }

  /** Each exported constant of a file, evaluated: how a token file with several `export const colors = {...}` is read. */
  evaluateExports(rel: string): Array<{ name: string; value: StaticValue }> {
    const file = this.load(rel)
    if (!file) return []
    const out: Array<{ name: string; value: StaticValue }> = []
    for (const [name, expression] of file.exports) out.push({ name, value: this.evaluate(file, expression) })
    const fallback = file.defaultExport
    if (fallback && !file.exports.has('default')) out.push({ name: 'default', value: this.evaluate(file, fallback) })
    return out
  }
}
