/**
 * setJsxClassName — Track B2. Adds/removes a class TOKEN in a `className`
 * attribute on the JSX element found at a source location, then writes the
 * change back to disk. This is the real write behind Phase 0 item 0.6's
 * honesty-only stopgap (`classAssignmentUnsavedNotice.ts`) and, per
 * `STUDIO-FIGMA-PARITY-PLAN.md` §5's B2, the thing that makes a Tailwind
 * project editable at all: a fill change on a Tailwind element is
 * `bg-red-500` -> `bg-blue-600`, a `className` token swap, not a CSS edit.
 *
 * FAILS CLOSED, on purpose, and reports WHY (`ClassNameRefusal`) rather than
 * guessing — same posture as `setJsxStyle` (identifier/spread guard) and
 * `detachComponent`/`swapComponentInstance` (named `{ ok, refusal }` result).
 * The shapes this file understands, and the refusal each other shape gets:
 *
 *   | `className` shape                          | Handling |
 *   |---------------------------------------------|----------|
 *   | absent                                       | creates the attribute |
 *   | `className="a b"` (plain string literal)     | token add/remove in place |
 *   | `className={"a b"}` / `` className={`a b`} `` (static expression) | same, token add/remove |
 *   | `` className={`a ${x}`} `` (dynamic template) | ADD appends to the STATIC HEAD only; any REMOVE refuses `template-dynamic` — a token that might live in the interpolated part can never be safely deleted from source text alone |
 *   | `className={cn('a', x)}` / `clsx`/`classNames`/`classnames` | ADD merges into (or appends) a literal string argument; REMOVE strips a token from every literal string argument it appears in (best-effort — a token produced only by a non-literal argument is left alone, matching every other Tier A/B/C path's "never guess" degrade) |
 *   | `className={styles.card}` (a CSS Modules default-import member access) | ADD rewrites it to `` className={`${styles.card} added`} `` — attaching a class is not editing a declaration; a REMOVE of a LITERAL token refuses `css-module-binding`, because that token is produced by the module and deleting it here would not delete it (removing the module token ITSELF is a different question — see "Module tokens" below) |
 *   | `className={...spread}`                      | refuses `spread-attribute` |
 *   | any other expression (identifier, ternary, an unrecognized call, …) | refuses `unsupported-expression` / `unsupported-call` |
 *
 * A request that changes nothing (both `add` and `remove` resolve to an empty
 * set once deduped, e.g. every token already present/absent) is a no-op —
 * `{ ok: true }` with the file untouched — so a caller never needs to
 * pre-filter, and an already-applied edit re-sent on a later autosave tick
 * doesn't re-refuse or rewrite anything.
 *
 * Node ids are `rel:line:col` pointing at the element's own tag-name start
 * (see `locateJsxElement.ts`); adding/removing characters inside an
 * attribute never changes the file's LINE count (no newline is ever
 * inserted), so this codemod never shifts another node's `line:col` the way
 * a structural edit does — same behaviour `setJsxProp`/`setJsxStyle` already
 * have. **That promise is load-bearing for the `module` token below**, and is
 * the whole reason this codemod refuses to ADD a missing `import` declaration
 * — see `css-module-import-missing`.
 *
 * ## Module tokens (`style-02`) — a class in a `*.module.css` is not a string
 *
 * A class that lives in a CSS Module has NO literal name in the user's app:
 * the bundler hashes it, so `className="Card_row__a1b2"` renders as nothing
 * outside whatever tool computed that particular hash. The only honest way to
 * attach one from source is the member expression its default import
 * provides — `styles.row`. So a caller names such a token structurally,
 * `{ kind: 'module', specifier, local }`, and this codemod resolves the
 * `specifier` to whatever local binding THAT file happens to use (`styles`,
 * `s`, `css`, …) before writing `<binding>.<local>` (or
 * `<binding>['<local>']` when `local` is not a JS identifier).
 *
 * Two named refusals guard it:
 *
 *   - `css-module-import-missing` — the file does not import that stylesheet
 *     at all. Adding the `import` would insert a LINE at the top of the file,
 *     shifting the `line:col` of every other edit still pending in the same
 *     batch (the exact hazard `orderStudioEditsForApply` and
 *     `pruneOrphanedImports`' post-pass exist to avoid). Refused by name, with
 *     the import to add spelled out, rather than risking a mis-aimed sibling
 *     write. A side-effect import that is already there (`import './x.module.css'`)
 *     is NOT this case — a default binding is added to it in place, which
 *     costs no line.
 *   - `css-module-binding` — an existing `className={styles.card}` where the
 *     caller asked to remove some OTHER token. Unchanged from before.
 *
 * Removing a module token IS supported where it is unambiguous: the whole
 * attribute when the binding is the entire value, or one `cn(...)` argument.
 * A token inside a template literal's interpolation still refuses
 * `template-dynamic`.
 */
import {
  Node,
  Project,
  type CallExpression,
  type JsxAttribute,
  type PropertyAccessExpression,
  type SourceFile,
  type TemplateExpression,
} from 'ts-morph'
import { CLASS_NAME_JOIN_BUILTIN_NAMES } from '@core/page-parser'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { topLevelBindingNames } from './importReconcile'

/**
 * One class this edit attaches to (or detaches from) an element.
 *
 *   - `literal` — an ordinary class name that IS its own string in the DOM: a
 *     plain `.css` rule, a Tailwind utility, a framework-generated class.
 *   - `module` — a class declared in a CSS Module, which has no literal name
 *     in the built app. `specifier` is the module specifier as it must appear
 *     in an `import` in THIS file (e.g. `./Card.module.css`); `local` is the
 *     class as WRITTEN in that file (e.g. `row`). See this module's
 *     "Module tokens".
 */
export type ClassNameToken =
  | { kind: 'literal'; token: string }
  | { kind: 'module'; specifier: string; local: string }

export interface SetJsxClassNameParams {
  file: string
  line: number
  col: number
  /** Class tokens to add. Order is not preserved — the codemod appends after existing tokens. */
  add: readonly ClassNameToken[]
  /** Class tokens to remove, wherever they appear as a whole token. */
  remove: readonly ClassNameToken[]
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

export type ClassNameRefusalReason =
  | 'spread-attribute'
  | 'css-module-binding'
  | 'css-module-import-missing'
  | 'template-dynamic'
  | 'unsupported-call'
  | 'unsupported-expression'

export interface ClassNameRefusal {
  reason: ClassNameRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export interface SetJsxClassNameSuccess {
  ok: true
}

export interface SetJsxClassNameFailure {
  ok: false
  refusal: ClassNameRefusal
}

export type SetJsxClassNameResult = SetJsxClassNameSuccess | SetJsxClassNameFailure

/** Splits on whitespace, drops empties, de-dupes — the shape every merge below starts from. */
function tokenize(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0)
}

function dedupe(tokens: readonly string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))]
}

/** A valid ES identifier — decides `styles.row` vs. `styles['row-2']`. */
const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The member-access text for a resolved module token: `styles.row` / `styles['row-2']`. */
function memberAccessText(binding: string, local: string): string {
  return JS_IDENTIFIER_RE.test(local) ? `${binding}.${local}` : `${binding}[${JSON.stringify(local)}]`
}

/**
 * How this file can reach `specifier`'s default export.
 *
 *   - `binding` — the local name to write, whether it already exists or is
 *     about to be introduced.
 *   - `bind` — set only when the file has a SIDE-EFFECT import of that
 *     stylesheet and needs a default binding added to it. Deliberately a
 *     deferred closure: the mutation must not happen on a path that ends in a
 *     refusal or a no-op, because `params.project` can be shared across
 *     several edits and an unsaved-then-saved-by-someone-else binding would
 *     leave an unused import behind (a `noUnusedLocals` build failure).
 *   - `null` — the file does not import that stylesheet at all.
 */
function moduleBindingFor(sourceFile: SourceFile, specifier: string): { binding: string; bind?: () => void } | null {
  const declaration = sourceFile.getImportDeclarations().find((imp) => imp.getModuleSpecifierValue() === specifier)
  if (!declaration) return null

  const existing = declaration.getDefaultImport()
  if (existing) return { binding: existing.getText() }

  // `import './Card.module.css'` — a side-effect import of a module
  // stylesheet. Giving it a binding is an in-place edit on the SAME line, so
  // it keeps this codemod's no-line-shift promise.
  if (declaration.getNamedImports().length > 0 || declaration.getNamespaceImport()) return null
  const bound = topLevelBindingNames(sourceFile)
  let binding = 'styles'
  let n = 2
  while (bound.has(binding)) {
    binding = `styles${n}`
    n += 1
  }
  return { binding, bind: () => declaration.setDefaultImport(binding) }
}

/** `add`/`remove` split into plain string tokens and resolved member-expression texts. */
interface ResolvedTokens {
  literals: string[]
  expressions: string[]
  /** Deferred import-binding mutations — run by `commit()` only, never on a refusal path. */
  pendingBinds: (() => void)[]
}

/**
 * Turns the caller's structural tokens into the two vocabularies every branch
 * below works in, resolving each `module` token through this file's own
 * imports. Refuses (never guesses a binding name) when the stylesheet is not
 * imported here at all.
 */
function resolveTokens(tokens: readonly ClassNameToken[], sourceFile: SourceFile): ResolvedTokens | ClassNameRefusal {
  const literals: string[] = []
  const expressions: string[] = []
  const pendingBinds: (() => void)[] = []
  for (const token of tokens) {
    if (token.kind === 'literal') {
      literals.push(token.token)
      continue
    }
    const resolved = moduleBindingFor(sourceFile, token.specifier)
    if (resolved === null) {
      return {
        reason: 'css-module-import-missing',
        message:
          `this class lives in ${token.specifier}, a CSS Module, so it can only be attached as a binding ` +
          `(e.g. \`styles.${token.local}\`) — but ${sourceFile.getBaseName()} does not import that stylesheet, and ` +
          'adding the import would move every other pending edit in this file. Add ' +
          `\`import styles from '${token.specifier}'\` to the file and try again.`,
      }
    }
    if (resolved.bind) pendingBinds.push(resolved.bind)
    expressions.push(memberAccessText(resolved.binding, token.local))
  }
  return { literals: dedupe(literals), expressions: dedupe(expressions), pendingBinds }
}

function isRefusal(value: ResolvedTokens | ClassNameRefusal): value is ClassNameRefusal {
  return 'reason' in value
}

/** Builds a plain `className="..."` attribute initializer, picking a quote character the value doesn't contain. */
function buildStringInitializer(value: string): string {
  const hasDouble = value.includes('"')
  const hasSingle = value.includes("'")
  if (!hasDouble) return `"${value}"`
  if (!hasSingle) return `'${value}'`
  return `{${JSON.stringify(value)}}`
}

/**
 * The whole attribute initializer for a set of plain tokens plus a set of
 * member expressions. Stays a plain string when there is no expression (the
 * ordinary, byte-cheapest shape), collapses to the bare expression when that
 * is all there is, and only reaches for a template literal when it genuinely
 * has to join the two.
 */
function buildInitializer(literals: readonly string[], expressions: readonly string[]): string {
  if (expressions.length === 0) return buildStringInitializer(literals.join(' '))
  if (literals.length === 0 && expressions.length === 1) return `{${expressions[0]}}`
  const parts = [...literals, ...expressions.map((expression) => '${' + expression + '}')]
  return '{`' + parts.join(' ') + '`}'
}

/**
 * Rewrites a STATIC `className` value (`"a b"`, `{"a b"}`, `` {`a b`} ``) for
 * one add/remove request. Plain-token-only requests keep the attribute's
 * existing string shape byte-for-byte apart from the tokens themselves; an
 * added module token promotes the whole initializer to a template literal,
 * which is the only shape that can carry both. An empty result drops the
 * attribute, exactly as before.
 */
function rewriteStaticClassName(
  attribute: JsxAttribute,
  current: string,
  setValue: (value: string) => void,
  add: ResolvedTokens,
  remove: ResolvedTokens,
): void {
  const removeSet = new Set(remove.literals)
  const kept = tokenize(current).filter((token) => !removeSet.has(token))
  for (const token of add.literals) {
    if (!kept.includes(token)) kept.push(token)
  }
  if (add.expressions.length === 0) {
    if (kept.length === 0) attribute.remove()
    else setValue(kept.join(' ')) // in place — keeps the author's `"…"` / `{"…"}` / `` {`…`} `` shape
    return
  }
  attribute.setInitializer(buildInitializer(kept, add.expressions))
}

/**
 * Appends `add` tokens to a template literal's STATIC HEAD — the text before
 * its first `${` — leaving every interpolated span untouched. This is the
 * only part of `` `a ${x}` `` this codemod ever owns: everything after the
 * first span depends on a runtime value it cannot read, let alone rewrite.
 */
function appendToTemplateHead(expr: TemplateExpression, add: readonly string[]): void {
  const head = expr.getHead()
  const headText = head.getText() // includes the leading backtick and trailing `${`
  const inner = headText.slice(1, -2)
  const tokens = tokenize(inner)
  for (const token of add) {
    if (!tokens.includes(token)) tokens.push(token)
  }
  const newInner = tokens.length > 0 ? `${tokens.join(' ')} ` : ''
  head.replaceWithText('`' + newInner + '${')
}

/**
 * `className={cn('a', x)}` / `clsx(...)` / `classNames(...)` / `classnames(...)`
 * — matched by identifier name only, the identical set §7.5's evaluator
 * treats as the class-name-join built-in (`CLASS_NAME_JOIN_BUILTIN_NAMES`).
 * Any other callee refuses `unsupported-call` rather than guessing what the
 * function does with its arguments.
 */
function applyClassNameJoinCall(
  expr: CallExpression,
  add: ResolvedTokens,
  remove: ResolvedTokens,
): ClassNameRefusal | null {
  const callee = expr.getExpression()
  if (!Node.isIdentifier(callee) || !CLASS_NAME_JOIN_BUILTIN_NAMES.has(callee.getText())) {
    return {
      reason: 'unsupported-call',
      message:
        `className is set by a function call ("${expr.getText()}") this codemod does not recognize as a ` +
        'class-name join (only cn/clsx/classNames/classnames) — refusing rather than guess what it does with its arguments.',
    }
  }

  if (remove.literals.length > 0 || remove.expressions.length > 0) {
    const removeSet = new Set(remove.literals)
    const removeExpressionSet = new Set(remove.expressions)
    const argsToRemove: Node[] = []
    for (const arg of expr.getArguments()) {
      // A module token is its own whole argument (`cn(styles.row, 'a')`), so
      // detaching one is an exact-text argument match — not a token split.
      if (removeExpressionSet.has(arg.getText())) {
        argsToRemove.push(arg)
        continue
      }
      if (!Node.isStringLiteral(arg)) continue // best-effort: a token only reachable through a non-literal argument is left alone
      const tokens = tokenize(arg.getLiteralValue())
      const kept = tokens.filter((token) => !removeSet.has(token))
      if (kept.length === tokens.length) continue
      if (kept.length === 0) argsToRemove.push(arg)
      else arg.setLiteralValue(kept.join(' '))
    }
    for (const arg of argsToRemove) expr.removeArgument(arg)
  }

  if (add.literals.length > 0) {
    const literalArg = expr.getArguments().find(Node.isStringLiteral)
    if (literalArg) {
      const tokens = tokenize(literalArg.getLiteralValue())
      for (const token of add.literals) {
        if (!tokens.includes(token)) tokens.push(token)
      }
      literalArg.setLiteralValue(tokens.join(' '))
    } else {
      expr.addArgument(JSON.stringify(add.literals.join(' ')))
    }
  }

  for (const expression of add.expressions) {
    if (expr.getArguments().some((arg) => arg.getText() === expression)) continue // already attached — idempotent re-send
    expr.addArgument(expression)
  }

  return null
}

/** `className={styles.card}` where `styles` is a default import from a `*.module.css` file. */
function isCssModuleBinding(expr: PropertyAccessExpression, sourceFile: SourceFile): boolean {
  const base = expr.getExpression()
  if (!Node.isIdentifier(base)) return false
  const name = base.getText()
  return sourceFile.getImportDeclarations().some((imp) => {
    if (!/\.module\.css$/i.test(imp.getModuleSpecifierValue())) return false
    const defaultImport = imp.getDefaultImport()
    return defaultImport !== undefined && defaultImport.getText() === name
  })
}

export function setJsxClassName(params: SetJsxClassNameParams): SetJsxClassNameResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  // Nothing requested — never even inspect the attribute's shape, so a
  // no-op request never refuses (e.g. a spread `className` the caller
  // happens to re-send unchanged on a later autosave tick). Checked BEFORE
  // token resolution so a no-op request also never adds an import binding.
  if (params.add.length === 0 && params.remove.length === 0) return { ok: true }

  const add = resolveTokens(params.add, sourceFile)
  if (isRefusal(add)) return { ok: false, refusal: add }
  const remove = resolveTokens(params.remove, sourceFile)
  if (isRefusal(remove)) return { ok: false, refusal: remove }

  const addCount = add.literals.length + add.expressions.length
  const removeCount = remove.literals.length + remove.expressions.length
  if (addCount === 0 && removeCount === 0) return { ok: true }

  /** The one place this codemod writes: apply any deferred import binding, then save. */
  const commit = (): SetJsxClassNameResult => {
    for (const bind of [...add.pendingBinds, ...remove.pendingBinds]) bind()
    sourceFile.saveSync()
    return { ok: true }
  }

  const existingAttribute = element.getAttribute('className')

  if (!existingAttribute) {
    if (addCount === 0) return { ok: true } // nothing to remove from an attribute that doesn't exist
    element.addAttribute({ name: 'className', initializer: buildInitializer(add.literals, add.expressions) })
    return commit()
  }

  if (!Node.isJsxAttribute(existingAttribute)) {
    // `getAttribute(name)` only matches a spread attribute if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real attribute name — guard against silently clobbering one anyway.
    return {
      ok: false,
      refusal: {
        reason: 'spread-attribute',
        message: 'the "className" attribute is a spread attribute — cannot edit an individual class token inside it.',
      },
    }
  }

  const initializer = existingAttribute.getInitializer()

  // Plain string literal attribute value: `className="a b"` (no braces —
  // this is the ordinary hand-written shape). A module token cannot already
  // be in a plain string, so a REMOVE of one is simply not present here;
  // an ADD promotes the attribute to a template literal.
  if (initializer && Node.isStringLiteral(initializer)) {
    rewriteStaticClassName(existingAttribute, initializer.getLiteralValue(), (v) => initializer.setLiteralValue(v), add, remove)
    return commit()
  }

  if (!initializer || !Node.isJsxExpression(initializer)) {
    return {
      ok: false,
      refusal: {
        reason: 'unsupported-expression',
        message: 'the "className" attribute has no rewritable value (a valueless shorthand, or a JSX-element/fragment initializer).',
      },
    }
  }

  const expr = initializer.getExpression()
  if (!expr) {
    return {
      ok: false,
      refusal: {
        reason: 'unsupported-expression',
        message: 'the "className" attribute has an empty expression container ({}) — nothing to rewrite.',
      },
    }
  }

  // `className={"a b"}` / `` className={`a b`} `` — a static string wrapped
  // in an expression container. Same token merge as the plain literal above.
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    rewriteStaticClassName(existingAttribute, expr.getLiteralValue(), (v) => expr.setLiteralValue(v), add, remove)
    return commit()
  }

  // `` className={`a ${x}`} `` — a template literal with an interpolated
  // part. See `appendToTemplateHead`'s doc for exactly what is and isn't
  // owned here.
  if (Node.isTemplateExpression(expr)) {
    if (removeCount > 0) {
      return {
        ok: false,
        refusal: {
          reason: 'template-dynamic',
          message:
            'className is a template literal with an interpolated value ("' +
            expr.getText() +
            '") — a class token could live in the dynamic part, so removing one cannot be done safely from source text alone.',
        },
      }
    }
    if (addCount === 0) return { ok: true }
    // A module token becomes its own interpolated span appended after the
    // existing ones — the static head can only hold plain names.
    const text = expr.getText()
    const missing = add.expressions.filter((expression) => !text.includes('${' + expression + '}'))
    if (add.literals.length > 0) appendToTemplateHead(expr, add.literals)
    if (missing.length > 0) {
      const current = expr.getText()
      expr.replaceWithText(current.slice(0, -1) + missing.map((e) => ' ${' + e + '}').join('') + '`')
    }
    return commit()
  }

  // `className={cn('a', x)}` / `clsx(...)` / `classNames(...)` / `classnames(...)`.
  if (Node.isCallExpression(expr)) {
    const refusal = applyClassNameJoinCall(expr, add, remove)
    if (refusal) return { ok: false, refusal }
    return commit()
  }

  // `className={styles.card}`.
  //
  // REMOVE still refuses, and for the reason the refusal always named: the
  // token the caller wants gone is produced by the module binding, and the
  // honest edit for it is the class's own declaration in the `.module.css`,
  // not this expression.
  //
  // ADD does not have that problem, and refusing it was over-application.
  // Attaching a class is not editing a declaration — it is putting one more
  // token on this one element, which is exactly what
  // `` className={`${styles.card} sc-abc`} `` says. The blanket refusal
  // mattered little while pages were mostly plain strings; it stopped
  // mattering little the moment the agent began authoring every element as a
  // CSS Module binding, at which point NO element on an agent-authored page
  // could take a class at all. The rewrite is single-line (no newline is
  // introduced), so it shifts no other node's `line:col`, same as every other
  // path here.
  if (Node.isPropertyAccessExpression(expr) && isCssModuleBinding(expr, sourceFile)) {
    const bindingText = expr.getText()
    // Detaching the module token that IS this whole attribute is the one
    // unambiguous removal here — the element stops carrying that class, which
    // is exactly what was asked, and nothing else is left to keep.
    if (remove.expressions.includes(bindingText) && remove.literals.length === 0 && addCount === 0) {
      existingAttribute.remove()
      return commit()
    }
    if (removeCount > 0) {
      return {
        ok: false,
        refusal: {
          reason: 'css-module-binding',
          message:
            `className is bound to a CSS Modules import ("${bindingText}") — that token comes from the module, so ` +
            "removing it here would not remove it. Edit the class's own declaration in the stylesheet instead.",
        },
      }
    }
    if (addCount === 0) return { ok: true }
    const expressions = [bindingText, ...add.expressions.filter((expression) => expression !== bindingText)]
    const parts = [...expressions.map((expression) => '${' + expression + '}'), ...add.literals]
    expr.replaceWithText('`' + parts.join(' ') + '`')
    return commit()
  }

  return {
    ok: false,
    refusal: {
      reason: 'unsupported-expression',
      message: `className is set by an expression ("${expr.getText()}") this codemod does not understand — refusing rather than guess.`,
    },
  }
}
